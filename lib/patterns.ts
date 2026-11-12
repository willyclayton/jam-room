// Drum patterns. Pure and deterministic: the same bar, style, feel and marks
// always give the same hits, so every drum phone plays the same thing.

import type { Feel, Mark, Style } from "./protocol";
import { BEATS_PER_BAR } from "./transport";

export type Drum =
  | "kick"
  | "snare"
  | "rim"
  | "hhc"
  | "hho"
  | "crash"
  | "tomH"
  | "tomM"
  | "tomL"
  | "shaker";

export type Hit = {
  drum: Drum;
  /** Position in the bar in 16ths (0..15). May be fractional for swing / laid-back feel. */
  step: number;
  vel: number;
};

export type BarInput = {
  bar: number;
  style: Style;
  feel: Feel;
  /** Marks whose beat falls in this bar or on its first beat. */
  marks: Mark[];
  /** Beat on which the drummer finishes, or null. */
  endBeat: number | null;
};

export const SWING: Record<Style, number> = {
  rock: 0.5,
  funk: 0.54,
  bossa: 0.5,
  lofi: 0.6,
};

const STEPS = 16;

/** Small seeded RNG so variations are random-sounding but identical on every phone. */
function rng(seed: number) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

export function barHits(input: BarInput): Hit[] {
  const { bar, style, feel, marks, endBeat } = input;
  const barStart = bar * BEATS_PER_BAR;
  const barEnd = barStart + BEATS_PER_BAR;
  const r = rng(bar * 31 + style.length * 7 + feel);

  // After the end: only the final crash on beat 1 of the end bar.
  if (endBeat !== null && barStart >= endBeat) {
    if (barStart === endBeat) {
      return [
        { drum: "crash", step: 0, vel: 1 },
        { drum: "kick", step: 0, vel: 1 },
      ];
    }
    return [];
  }

  // Where does a fill start in this bar (in 16ths), if anywhere?
  let fillFrom: number | null = null;
  for (const m of marks) {
    if (m.kind === "fill" && m.beat >= barStart && m.beat < barEnd) {
      fillFrom = (m.beat - barStart) * 4;
    }
  }
  const markedBar = marks.some((m) => m.beat >= barStart && m.beat < barEnd);
  if (fillFrom === null && !markedBar && bar > 0) {
    // Phrase fills: end of every 8 bars, or every 4 when playing hard.
    if (bar % 8 === 7) fillFrom = feel === 0 ? 12 : 8;
    else if (bar % 4 === 3 && feel === 2) fillFrom = 12;
  }

  // Crash on beat 1 if a fill came before, or a crash mark is here.
  const crash =
    marks.some((m) => m.kind === "crash" && m.beat === barStart) ||
    marks.some((m) => m.kind === "fill" && m.beat >= barStart - 4 && m.beat < barStart) ||
    (bar > 0 && bar % 8 === 0 && !markedBar);

  let hits = groove(style, feel, bar, r);
  if (fillFrom !== null) {
    const from = fillFrom;
    // The fill replaces the groove from `from` (it brings its own quarter-note kicks).
    hits = hits.filter((h) => h.step < from);
    hits.push(...fill(style, feel, from, r));
  }
  if (crash) {
    hits = hits.filter((h) => !(h.step === 0 && (h.drum === "hhc" || h.drum === "hho")));
    hits.push({ drum: "crash", step: 0, vel: feel === 0 ? 0.6 : 0.9 });
    if (!hits.some((h) => h.drum === "kick" && h.step === 0)) hits.push({ drum: "kick", step: 0, vel: 0.9 });
  }
  return hits;
}

// ---------------------------------------------------------------------------

function groove(style: Style, feel: Feel, bar: number, r: () => number): Hit[] {
  switch (style) {
    case "rock":
      return rock(feel, bar, r);
    case "funk":
      return funk(feel, bar, r);
    case "bossa":
      return bossa(feel, bar, r);
    case "lofi":
      return lofi(feel, bar, r);
  }
}

function seq(drum: Drum, steps: number[], vel: number | ((step: number) => number)): Hit[] {
  return steps.map((step) => ({ drum, step, vel: typeof vel === "number" ? vel : vel(step) }));
}

const range = (from: number, to: number, by: number) => {
  const out: number[] = [];
  for (let i = from; i < to; i += by) out.push(i);
  return out;
};

/** Accent on the beat, softer in between. */
const hatVel = (base: number) => (s: number) =>
  s % 4 === 0 ? base : s % 2 === 0 ? base * 0.72 : base * 0.5;

function rock(feel: Feel, bar: number, r: () => number): Hit[] {
  if (feel === 0) {
    // Half-time: kick on 1, rim click on 3, soft quarter-note hats.
    return [
      ...seq("kick", [0], 0.85),
      ...(r() < 0.5 ? seq("kick", [10], 0.6) : []),
      ...seq("rim", [8], 0.7),
      ...seq("hhc", range(0, STEPS, 4), 0.45),
    ];
  }
  if (feel === 1) {
    const kicks = [0, 8, ...(bar % 2 === 1 ? [10] : r() < 0.35 ? [6] : [])];
    return [
      ...seq("kick", kicks, (s) => (s === 0 ? 1 : 0.85)),
      ...seq("snare", [4, 12], 0.9),
      ...seq("hhc", range(0, STEPS, 2), hatVel(0.7)),
    ];
  }
  // Hard: 16th hats, more kicks, open hat at the end of the bar.
  const kicks = [0, 3, 8, 10, ...(r() < 0.5 ? [7] : [14])];
  const hats = range(0, STEPS, 1).filter((s) => s !== 14);
  return [
    ...seq("kick", kicks, (s) => (s % 4 === 0 ? 1 : 0.8)),
    ...seq("snare", [4, 12], 1),
    ...(r() < 0.4 ? seq("snare", [15], 0.35) : []),
    ...seq("hhc", hats, hatVel(0.8)),
    ...seq("hho", [14], 0.7),
  ];
}

function funk(feel: Feel, bar: number, r: () => number): Hit[] {
  if (feel === 0) {
    return [
      ...seq("kick", [0, 10], 0.8),
      ...seq("rim", [4, 12], 0.6),
      ...seq("hhc", range(0, STEPS, 2), hatVel(0.5)),
    ];
  }
  const ghosts = feel === 2 ? [7, 9, 13, 15] : [7, 9];
  const kicks =
    feel === 2
      ? [0, 3, 6, 10, 11]
      : [0, 10, ...(bar % 2 === 1 ? [3] : r() < 0.5 ? [7] : [])];
  return [
    ...seq("kick", kicks, (s) => (s === 0 ? 1 : 0.85)),
    ...seq("snare", [4, 12], 0.95),
    ...seq("snare", ghosts.filter(() => r() < 0.85), 0.22),
    ...seq("hhc", range(0, STEPS, 1).filter((s) => s !== 14 || feel !== 2), hatVel(feel === 2 ? 0.75 : 0.6)),
    ...(feel === 2 ? seq("hho", [14], 0.6) : []),
  ];
}

function bossa(feel: Feel, bar: number, r: () => number): Hit[] {
  // Surdo-style kick: on the beat and the "a" before the next one.
  const kick = seq("kick", [0, 3, 4, 7, 8, 11, 12, 15], (s) => (s % 4 === 0 ? 0.75 : 0.45));
  // 2-bar bossa clave on the rim.
  const clave = bar % 2 === 0 ? [0, 6, 12] : [4, 10];
  const hits = [...kick, ...seq("rim", clave, 0.75)];
  if (feel === 0) return hits;
  if (feel === 1) return [...hits, ...seq("hhc", range(0, STEPS, 2), hatVel(0.45))];
  return [
    ...hits,
    ...seq("shaker", range(0, STEPS, 1), (s) => (s % 2 === 0 ? 0.5 : 0.3) + r() * 0.05),
    ...seq("hhc", range(0, STEPS, 4), 0.4),
  ];
}

function lofi(feel: Feel, bar: number, r: () => number): Hit[] {
  // Lazy snare: a touch behind the beat.
  const late = 0.18;
  if (feel === 0) {
    return [
      ...seq("kick", [0, 10], 0.85),
      ...seq("rim", [12 + late], 0.6),
      ...seq("hhc", range(0, STEPS, 4), 0.4),
    ];
  }
  const kicks = feel === 2 ? [0, 3, 7, 10] : [0, 7, 10, ...(bar % 4 === 3 ? [15] : [])];
  return [
    ...seq("kick", kicks, (s) => (s === 0 ? 0.95 : 0.75)),
    ...seq("snare", [4 + late, 12 + late], 0.8),
    ...seq("hhc", range(0, STEPS, feel === 2 ? 1 : 2), (s) => hatVel(0.55)(s) * (0.85 + r() * 0.3)),
  ];
}

// ---------------------------------------------------------------------------

function fill(style: Style, feel: Feel, from: number, r: () => number): Hit[] {
  const steps = range(from, STEPS, 1);
  const len = steps.length;
  const soft = style === "bossa" || style === "lofi" || feel === 0;
  const kind = Math.floor(r() * 3);
  const out: Hit[] = [];

  steps.forEach((s, i) => {
    const pos = i / Math.max(1, len - 1);
    const vel = (soft ? 0.45 : 0.6) + pos * (soft ? 0.3 : 0.4);
    if (kind === 0) {
      // Snare roll that grows, 16ths on the hard feel, 8ths otherwise.
      if (feel === 2 || s % 2 === 0) out.push({ drum: "snare", step: s, vel });
    } else if (kind === 1) {
      // Down the toms.
      const drums: Drum[] = soft ? ["rim", "tomH", "tomM", "tomL"] : ["snare", "tomH", "tomM", "tomL"];
      const d = drums[Math.min(drums.length - 1, Math.floor(pos * drums.length))];
      if (feel === 2 || s % 2 === 0 || !soft) out.push({ drum: d, step: s, vel });
    } else {
      // Snare / tom call and answer in 8ths with a flam-ish double at the end.
      if (s % 2 === 0) out.push({ drum: i % 4 < 2 ? "snare" : "tomM", step: s, vel });
      if (s === STEPS - 1) out.push({ drum: "tomL", step: s, vel });
    }
    if (s % 4 === 0) out.push({ drum: "kick", step: s, vel: 0.7 });
  });
  return out;
}
