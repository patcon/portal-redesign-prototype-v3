/**
 * Turning the voice socket's raw audio into something a browser will play.
 *
 * `agents/voice` sends headerless PCM — 16 kHz mono 16-bit little-endian, the
 * format `TranscriberSession.feed` is documented to take. That is the whole
 * reason recordings are simple here: raw PCM concatenates byte for byte, so a
 * recording split across many R2 objects needs no remux, no container and no
 * codec. Playback is these 44 bytes followed by the audio.
 */

/** The rate the voice client's capture worklet resamples to. */
export const SAMPLE_RATE = 16_000;

/** 16-bit mono: two bytes carry one sample. */
export const BYTES_PER_SAMPLE = 2;

/**
 * The length written into a WAV still being recorded.
 *
 * A RIFF header has to state its size up front, which a live recording does not
 * know. `0xffffffff` is the conventional "stream of unknown length": browsers
 * play it and keep reading until the connection closes. The cost is that the
 * duration is unknown and the audio is not seekable until the recording ends
 * and the real length can be sent.
 */
export const STREAMING_SIZE = 0xffffffff;

/**
 * The 44-byte canonical RIFF/WAVE header for `dataBytes` of PCM.
 *
 * Pass {@link STREAMING_SIZE} for a recording in progress.
 */
export function wavHeader(dataBytes: number, sampleRate = SAMPLE_RATE): Uint8Array {
  const blockAlign = BYTES_PER_SAMPLE;
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);

  const writeTag = (offset: number, tag: string) => {
    for (let i = 0; i < tag.length; i++) view.setUint8(offset + i, tag.charCodeAt(i));
  };

  writeTag(0, "RIFF");
  // The RIFF chunk covers everything after this field: 36 header bytes plus the
  // audio. An unknown-length stream stays at the placeholder rather than
  // wrapping around past 2^32.
  view.setUint32(4, dataBytes === STREAMING_SIZE ? STREAMING_SIZE : 36 + dataBytes, true);
  writeTag(8, "WAVE");
  writeTag(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // format: uncompressed PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeTag(36, "data");
  view.setUint32(40, dataBytes, true);

  return header;
}

/** How long `bytes` of this format plays for. */
export function durationSeconds(bytes: number, sampleRate = SAMPLE_RATE): number {
  return bytes / (sampleRate * BYTES_PER_SAMPLE);
}

/**
 * The loudest sample in a chunk of PCM, as 0–1.
 *
 * One of these per flushed segment is the waveform the voice note draws. Peak
 * rather than RMS because the bars are read at a glance, and peak keeps a quiet
 * room visibly quieter than a spoken sentence without any smoothing.
 */
export function peakOf(pcm: Uint8Array): number {
  const samples = new Int16Array(
    pcm.buffer,
    pcm.byteOffset,
    Math.floor(pcm.byteLength / BYTES_PER_SAMPLE),
  );
  let peak = 0;
  for (const sample of samples) {
    // -32768 has no positive counterpart, so negate through a wider type.
    const magnitude = sample < 0 ? -sample : sample;
    if (magnitude > peak) peak = magnitude;
  }
  return peak / 32768;
}

/**
 * A soft chime marking the point where a paused recording picks up again.
 *
 * Muting stops the client sending audio altogether, so the frames on either
 * side of a pause concatenate into one continuous-sounding stretch — a splice
 * nobody listening back can hear, between two moments that may be minutes
 * apart. This is what goes in the seam so the break is audible.
 *
 * Quiet and short on purpose: it is a punctuation mark in someone's
 * conversation, not an alert. Two pops rather than one, because a single tone
 * in a recording of a room is something that might have been in the room,
 * while a matched pair is plainly put there. A Hann envelope over each pop
 * takes it up from and back down to true silence, so the tone splices into raw
 * PCM without the click an abrupt edge would give.
 */
const POP_SECONDS = 0.06;
const POP_GAP_SECONDS = 0.06;
const TONE_HZ = 587.33; // D5 — high enough to read as a marker over speech.
const TONE_GAIN = 0.12;

let tone: Uint8Array | null = null;

export function resumeTone(): Uint8Array {
  if (tone) return tone;

  const pop = Math.round(SAMPLE_RATE * POP_SECONDS);
  const gap = Math.round(SAMPLE_RATE * POP_GAP_SECONDS);
  const pcm = new Int16Array(pop * 2 + gap);

  const writePop = (at: number) => {
    for (let i = 0; i < pop; i++) {
      const envelope = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (pop - 1));
      const wave = Math.sin((2 * Math.PI * TONE_HZ * i) / SAMPLE_RATE);
      pcm[at + i] = Math.round(wave * envelope * TONE_GAIN * 32767);
    }
  };
  writePop(0);
  writePop(pop + gap);

  tone = new Uint8Array(pcm.buffer);
  return tone;
}
