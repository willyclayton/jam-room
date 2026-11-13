// Auto-jam: the guitar plays a chord loop by itself, in time with the drums.
// Pure and deterministic, like the drum patterns, so every phone agrees on
// which chord is playing in which bar.

import { CHORDS, type ChordName } from "./chords";
import type { Style } from "./protocol";

export const LOOP_BARS = 4;

export const PRESETS: { name: string; chords: ChordName[] }[] = [
  { name: "Pop", chords: ["G", "D", "Em", "C"] },
  { name: "Ballad", chords: ["C", "G", "Am", "F"] },
  { name: "Sad", chords: ["Am", "F", "C", "G"] },
  { name: "Folk", chords: ["G", "C", "G", "D"] },
];

export const DEFAULT_PROGRESSION: ChordName[] = PRESETS[0].chords;

export function isProgression(x: unknown): x is ChordName[] {
  return Array.isArray(x) && x.length === LOOP_BARS && x.every((c) => CHORDS.includes(c as ChordName));
}

/** Which chord plays in bar `bar` (bar 0 is the first bar of the jam). */
export function chordForBar(progression: ChordName[], bar: number): ChordName {
  const n = progression.length;
  return progression[((bar % n) + n) % n];
}

export type AutoStrum = {
  /** Position in the bar in 8th notes (0..7). */
  step: number;
  dir: "down" | "up";
  strength: number;
};

const D = (step: number, strength = 0.7): AutoStrum => ({ step, dir: "down", strength });
const U = (step: number, strength = 0.45): AutoStrum => ({ step, dir: "up", strength });

/** One bar of strumming per style. `feel` 0 = soft and sparse, 2 = hard and busy. */
export function strumPattern(style: Style, feel: 0 | 1 | 2): AutoStrum[] {
  if (feel === 0) {
    // Soft: let the chord ring.
    return style === "bossa" ? [D(0, 0.4), U(3, 0.3), D(4, 0.35)] : [D(0, 0.45), D(4, 0.35)];
  }
  const busy = feel === 2;
  switch (style) {
    case "rock":
      // D . D U . U D U: the classic campfire pattern
      return busy
        ? [D(0, 0.9), U(1), D(2, 0.8), U(3), D(4, 0.9), U(5), D(6, 0.8), U(7)]
        : [D(0), D(2), U(3), U(5), D(6), U(7)];
    case "funk":
      // Choppy 8ths with accents on the backbeat
      return [D(0, 0.75), U(1, 0.3), D(2, 0.5), U(3, 0.3), D(4, 0.75), U(5, 0.3), D(6, 0.5), U(7, busy ? 0.5 : 0.3)];
    case "bossa":
      return [D(0, 0.55), U(3, 0.4), D(4, 0.45), U(6, 0.35), ...(busy ? [U(7, 0.3)] : [])];
    case "lofi":
      return busy ? [D(0, 0.55), U(3, 0.35), D(4, 0.5), U(6, 0.3), U(7, 0.3)] : [D(0, 0.5), U(3, 0.3), D(4, 0.45)];
  }
}
