import { describe, expect, it } from "vitest";
import { CallLog } from "./call-log";

/** The three methods of `DurableObjectStorage` the log actually touches. */
function fakeStorage() {
  const map = new Map<string, unknown>();
  return {
    map,
    storage: {
      get: <T>(key: string) => Promise.resolve(map.get(key) as T | undefined),
      put: (key: string, value: unknown) => {
        map.set(key, value);
        return Promise.resolve();
      },
      delete: (key: string) => Promise.resolve(map.delete(key)),
    },
  };
}

describe("CallLog", () => {
  it("collects the utterances of a call in order", async () => {
    const log = new CallLog(fakeStorage().storage);
    await log.start("c1");
    await log.append("c1", "hello");
    await log.append("c1", "there");
    expect(await log.end("c1")).toEqual(["hello", "there"]);
  });

  it("keeps calls on different connections apart", async () => {
    const log = new CallLog(fakeStorage().storage);
    await log.append("c1", "mine");
    await log.append("c2", "yours");
    expect(await log.end("c1")).toEqual(["mine"]);
    expect(await log.end("c2")).toEqual(["yours"]);
  });

  // The whole point of writing this to storage: a Durable Object evicted
  // mid-call comes back with empty memory, and the call has to continue
  // rather than hand back only what was said after the wake.
  it("survives an instance that lost its memory mid-call", async () => {
    const { storage } = fakeStorage();
    await new CallLog(storage).append("c1", "before the eviction");

    const rebuilt = new CallLog(storage);
    await rebuilt.start("c1");
    await rebuilt.append("c1", "after the eviction");

    expect(await rebuilt.end("c1")).toEqual(["before the eviction", "after the eviction"]);
  });

  // `start` runs again when a call is resumed after a rebuild, and must not
  // throw away what the call had already heard.
  it("does not clear a call that is already under way", async () => {
    const { storage } = fakeStorage();
    const log = new CallLog(storage);
    await log.append("c1", "said before");
    await log.start("c1");
    expect(await log.end("c1")).toEqual(["said before"]);
  });

  it("forgets the call once it has ended", async () => {
    const { storage, map } = fakeStorage();
    const log = new CallLog(storage);
    await log.append("c1", "hello");
    await log.end("c1");
    expect(await log.end("c1")).toEqual([]);
    expect(map.size).toBe(0);
  });
});
