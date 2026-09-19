/**
 * What a call has heard so far, kept in Durable Object storage rather than in
 * memory.
 *
 * An open call does not keep its object resident. The SDK's sockets hibernate,
 * so a quiet stretch — the participant mutes, audio frames stop — lets the
 * object be evicted with the socket still open, and it comes back with every
 * field reset. Holding the utterances in memory meant the message written at
 * hang-up contained only whatever was said after the last eviction.
 */

/** The slice of `DurableObjectStorage` this needs, so it can be tested plainly. */
export interface CallLogStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

const key = (connectionId: string) => `call:${connectionId}`;

export class CallLog {
  #storage: CallLogStorage;

  constructor(storage: CallLogStorage) {
    this.#storage = storage;
  }

  /**
   * Open a call. Idempotent: a call resumed after an eviction starts again on
   * the new instance, and must not lose what the old one recorded.
   */
  async start(connectionId: string): Promise<void> {
    const existing = await this.#storage.get<string[]>(key(connectionId));
    if (!existing) await this.#storage.put(key(connectionId), []);
  }

  async append(connectionId: string, utterance: string): Promise<string[]> {
    const utterances = await this.read(connectionId);
    utterances.push(utterance);
    await this.#storage.put(key(connectionId), utterances);
    return utterances;
  }

  async read(connectionId: string): Promise<string[]> {
    return (await this.#storage.get<string[]>(key(connectionId))) ?? [];
  }

  /** Take everything the call heard and forget it. */
  async end(connectionId: string): Promise<string[]> {
    const utterances = await this.read(connectionId);
    await this.#storage.delete(key(connectionId));
    return utterances;
  }
}
