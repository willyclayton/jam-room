import type { Segment, Transport } from "./protocol";

export const BEATS_PER_BAR = 4;

export function beatMs(bpm: number) {
  return 60000 / bpm;
}

/** The segment in force at shared time `t` (the first one if `t` is before all of them). */
export function segmentAtTime(segments: Segment[], t: number): Segment {
  let seg = segments[0];
  for (const s of segments) {
    if (s.time <= t) seg = s;
    else break;
  }
  return seg;
}

/** The segment in force at beat `beat`. */
export function segmentAtBeat(segments: Segment[], beat: number): Segment {
  let seg = segments[0];
  for (const s of segments) {
    if (s.beat <= beat) seg = s;
    else break;
  }
  return seg;
}

export function timeOfBeat(segments: Segment[], beat: number): number {
  const s = segmentAtBeat(segments, beat);
  return s.time + (beat - s.beat) * beatMs(s.bpm);
}

export function beatAtTime(segments: Segment[], t: number): number {
  const s = segmentAtTime(segments, t);
  return s.beat + (t - s.time) / beatMs(s.bpm);
}

export function emptyTransport(epoch = 0): Transport {
  return { epoch, playing: false, segments: [], marks: [], endBeat: null };
}
