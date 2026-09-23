import { useEffect, useMemo, useState } from "react";
import { recordingPath } from "../shared";
import type { RecordingMeta } from "../types";

/** How often to re-read a recording that is still being made. */
const POLL_MS = 3000;

/**
 * How long each call in this thread is, and how loud it has been.
 *
 * The message that opens a call is written before a single frame of audio
 * exists and is never rewritten, so the voice note cannot carry its own length
 * — it would be zero forever. Instead the recording answers for itself here,
 * and a call still in progress is re-read while it runs, which is what makes
 * the bars grow as people speak. Once a recording ends it stops being polled:
 * its length is final and will not change again.
 */
export function useRecordings(
  eventId: string,
  chatId: string,
  recordingIds: string[],
): Record<string, RecordingMeta> {
  const [recordings, setRecordings] = useState<Record<string, RecordingMeta>>({});

  // `recordingIds` is a fresh array on every render; the effect below should
  // re-run when the *calls* change, not when the thread does.
  const key = recordingIds.join(",");

  useEffect(() => {
    const ids = key ? key.split(",") : [];
    if (ids.length === 0) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const read = async () => {
      const results = await Promise.all(
        ids.map(async (id) => {
          try {
            const response = await fetch(recordingPath(eventId, chatId, id, "json"));
            if (!response.ok) return [id, null] as const;
            return [id, (await response.json()) as RecordingMeta] as const;
          } catch {
            // A recording nobody can reach is a voice note that stays at zero,
            // which is better than a thread that fails to render.
            return [id, null] as const;
          }
        }),
      );
      if (cancelled) return;

      const next: Record<string, RecordingMeta> = {};
      for (const [id, meta] of results) if (meta) next[id] = meta;
      setRecordings(next);

      // Only a call still running has anything left to tell us.
      if (results.some(([, meta]) => meta && !meta.ended)) {
        timer = setTimeout(read, POLL_MS);
      }
    };

    void read();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [eventId, chatId, key]);

  return recordings;
}

/** Where this conversation's recordings are played from. */
export function useRecordingHref(eventId: string, chatId: string): (id: string) => string {
  return useMemo(
    () => (recordingId: string) => recordingPath(eventId, chatId, recordingId, "wav"),
    [eventId, chatId],
  );
}
