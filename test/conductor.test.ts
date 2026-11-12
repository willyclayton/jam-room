import { describe, expect, it } from "vitest";
import { Conductor } from "../lib/conductor";
import { beatAtTime, beatMs, segmentAtTime, timeOfBeat } from "../lib/transport";
import { detectCountIn, fitGrid, foldBpm } from "../lib/tempo";
import { barHits } from "../lib/patterns";
import type { Segment } from "../lib/protocol";

/** Deterministic noise in [-1, 1]. */
function noise(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s / 2147483647) * 2 - 1;
  };
}

type Sim = {
  c: Conductor;
  /** For each strum after the drums started: distance (ms) to the nearest drum beat. */
  offsets: { at: number; ms: number }[];
  bpmLog: { at: number; bpm: number }[];
};

/**
 * Plays a list of strum times into a conductor with network delay and ticks,
 * recording how far each strum lands from the drummer's grid.
 */
function simulate(
  strums: number[],
  opts: { latency?: number; rtt?: number; tail?: number; grid?: 1 | 2 } = {},
): Sim {
  const grid = opts.grid ?? 1;
  const latency = opts.latency ?? 40;
  const c = new Conductor();
  c.state.players = [{ id: "d", name: "drums", role: "drums", rtt: opts.rtt ?? 80 }];
  const offsets: Sim["offsets"] = [];
  const bpmLog: Sim["bpmLog"] = [];
  // Snapshot of the grid as each drum phone would have scheduled it: once a
  // segment's time has passed it can't change.
  const played: Segment[] = [];
  const events = strums.map((at) => ({ at, now: at + latency }));
  const end = strums[strums.length - 1] + (opts.tail ?? 0);
  let i = 0;
  for (let now = strums[0]; now <= end; now += 10) {
    while (i < events.length && events[i].now <= now) {
      const e = events[i++];
      const t = c.state.transport;
      if (t.playing && t.segments[0].time <= e.at) {
        const b = beatAtTime(t.segments, e.at) * grid;
        const ms = ((b - Math.round(b)) * beatMs(segmentAtTime(t.segments, e.at).bpm)) / grid;
        offsets.push({ at: e.at, ms });
      }
      c.strum(e.now, e.at, "G", 0.5);
    }
    c.tick(now);
    const t = c.state.transport;
    for (const s of t.segments) {
      if (s.time <= now && !played.some((p) => p.beat === s.beat)) {
        played.push(s);
        bpmLog.push({ at: s.time, bpm: s.bpm });
      }
    }
  }
  return { c, offsets, bpmLog };
}

function steady(start: number, bpm: number, beats: number, jitter = 0, seed = 1): number[] {
  const n = noise(seed);
  return Array.from({ length: beats }, (_, k) => start + k * beatMs(bpm) + n() * jitter);
}

/** Tempo that moves smoothly from bpm0 to bpm1 over `beats`. */
function ramp(start: number, bpm0: number, bpm1: number, beats: number, jitter = 0, seed = 2): number[] {
  const n = noise(seed);
  const out: number[] = [];
  let t = start;
  for (let k = 0; k < beats; k++) {
    out.push(t + n() * jitter);
    t += beatMs(bpm0 + ((bpm1 - bpm0) * k) / beats);
  }
  return out;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const meanAbs = (xs: number[]) => mean(xs.map(Math.abs));

describe("tempo helpers", () => {
  it("folds 8th-note strumming into a quarter-note tempo", () => {
    expect(foldBpm(200)).toBe(100);
    expect(foldBpm(55)).toBe(110);
  });

  it("detects a steady count-in and ignores an uneven one", () => {
    expect(detectCountIn([0, 600, 1200, 1800])?.bpm).toBeCloseTo(100, 0);
    expect(detectCountIn([0, 600, 900, 1800])).toBeNull();
  });

  it("tracks the period through mixed quarter and 8th strums", () => {
    // Grid is at 520ms beats; the guitarist is really at 500ms.
    const onsets = [0, 500, 750, 1000, 1500, 1750, 2000, 2510];
    const fit = fitGrid(onsets, (t) => t / 520, 520);
    expect(fit?.period).toBeCloseTo(500, -1);
  });
});

describe("conductor", () => {
  it("counts in on 4 strums and lands the first downbeat on the next bar", () => {
    const strums = steady(1000, 100, 4);
    const { c } = simulate(strums, { tail: 100 });
    const t = c.state.transport;
    expect(t.playing).toBe(true);
    expect(c.state.bpm).toBeCloseTo(100, 0);
    // Beat 1 of the count-in bar was the first strum, so the drummer's bar
    // starts exactly one bar of 600ms beats later.
    expect(t.segments[0].time).toBeCloseTo(1000 + 4 * 600, 0);
  });

  it("stays in time at a steady tempo with human jitter", () => {
    const strums = steady(0, 110, 64, 12);
    const { offsets, c } = simulate(strums);
    expect(c.state.bpm).toBeGreaterThan(107);
    expect(c.state.bpm).toBeLessThan(113);
    expect(meanAbs(offsets.map((o) => o.ms))).toBeLessThan(15);
  });

  it("follows the guitarist drifting faster and slower", () => {
    const a = steady(0, 90, 16, 8);
    const b = ramp(a[15] + beatMs(90), 90, 110, 32, 8);
    const c1 = steady(b[31] + beatMs(110), 110, 24, 8);
    const d = ramp(c1[23] + beatMs(110), 110, 90, 32, 8);
    const e = steady(d[31] + beatMs(90), 90, 24, 8);
    const { offsets, c } = simulate([...a, ...b, ...c1, ...d, ...e]);
    const inRange = (arr: number[], skip = 0) =>
      offsets.filter((o) => o.at >= arr[skip] && o.at <= arr[arr.length - 1]).map((o) => o.ms);

    // Once the tempo holds again, the drummer is back on the strums within 2 bars.
    expect(meanAbs(inRange(c1, 8))).toBeLessThan(20);
    expect(meanAbs(inRange(e, 8))).toBeLessThan(20);
    // While the guitarist drifts (20% over 8 bars, fast for a human), the
    // drummer trails a little but never loses the beat.
    const drifting = [...inRange(b), ...inRange(d)];
    expect(meanAbs(drifting)).toBeLessThan(75);
    expect(Math.max(...drifting.map(Math.abs))).toBeLessThan(130);
    expect(c.state.bpm).toBeGreaterThan(88);
    expect(c.state.bpm).toBeLessThan(92);
  });

  for (const [from, to] of [
    [90, 120],
    [120, 85],
  ]) {
    it(`re-locks within 2 bars when the guitarist jumps from ${from} to ${to} bpm`, () => {
      const a = steady(0, from, 24, 8);
      const b = steady(a[23] + beatMs(from), to, 32, 8);
      const { offsets, c } = simulate([...a, ...b]);
      expect(c.state.bpm).toBeGreaterThan(to * 0.97);
      expect(c.state.bpm).toBeLessThan(to * 1.03);
      const after = offsets.filter((o) => o.at >= b[8]).map((o) => o.ms);
      expect(meanAbs(after)).toBeLessThan(20);
    });
  }

  for (const latency of [-15, 0, 5]) {
    it(`corrects a slightly-off count-in on a fast network (latency ${latency} ms)`, () => {
      // The first gap is short, so the count-in tempo is ~1% fast. The drummer
      // must pull back onto the strums rather than drift away.
      const strums = [0, 581, ...Array.from({ length: 40 }, (_, k) => 581 + (k + 1) * 600)];
      const { offsets } = simulate(strums, { latency, rtt: 4 });
      expect(meanAbs(offsets.slice(8).map((o) => o.ms))).toBeLessThan(10);
    });
  }

  it("follows 8th-note strumming the same as quarter notes", () => {
    const strums = steady(0, 200, 96, 6); // 8ths at 100 bpm
    const { c, offsets } = simulate(strums, { grid: 2 });
    expect(c.state.bpm).toBeCloseTo(100, -1);
    expect(meanAbs(offsets.map((o) => o.ms))).toBeLessThan(15);
  });

  it("books changes 2 beats ahead on a slow connection", () => {
    const c = new Conductor();
    c.state.players = [{ id: "d", name: "", role: "drums", rtt: 300 }];
    expect(c.leadMs(120)).toBeCloseTo(1000, 0);
    c.state.players[0].rtt = 50;
    expect(c.leadMs(120)).toBeCloseTo(500, 0);
  });

  it("plays a fill and ends when the guitarist stops", () => {
    const strums = steady(0, 120, 24);
    const { c } = simulate(strums, { tail: 6000 });
    const t = c.state.transport;
    expect(t.endBeat).not.toBeNull();
    expect(t.endBeat! % 4).toBe(0);
    expect(t.marks.some((m) => m.kind === "fill" && m.beat === t.endBeat! - 2)).toBe(true);
    // ...and then goes quiet.
    c.tick(timeOfBeat(t.segments, t.endBeat!) + 2000);
    expect(c.state.transport.playing).toBe(false);
  });

  it("adds a fill when the chord changes after a long hold", () => {
    const c = new Conductor();
    c.state.players = [{ id: "d", name: "", role: "drums", rtt: 50 }];
    const strums = steady(0, 120, 20);
    for (const at of strums) c.strum(at + 20, at, "G", 0.5);
    const at = strums[19] + 500;
    c.strum(at + 20, at, "C", 0.5);
    expect(c.state.transport.marks.some((m) => m.beat > 0)).toBe(true);
  });

  it("strums harder for a busier beat, softer for half-time", () => {
    const c = new Conductor();
    const strums = steady(0, 120, 12);
    for (const at of strums) c.strum(at + 20, at, "G", 1);
    expect(c.state.feel).toBe(2);
    for (const at of steady(strums[11] + 500, 120, 12)) c.strum(at + 20, at, "G", 0.05);
    expect(c.state.feel).toBe(0);
  });
});

describe("patterns", () => {
  it("is deterministic so every drum phone agrees", () => {
    const input = { bar: 5, style: "funk" as const, feel: 2 as const, marks: [], endBeat: null };
    expect(barHits(input)).toEqual(barHits(input));
  });

  it("plays only the final crash on the end beat and nothing after", () => {
    const end = barHits({ bar: 3, style: "rock", feel: 1, marks: [], endBeat: 12 });
    expect(end.map((h) => h.drum).sort()).toEqual(["crash", "kick"]);
    expect(barHits({ bar: 4, style: "rock", feel: 1, marks: [], endBeat: 12 })).toEqual([]);
  });

  it("plays a fill on the last bar of each 8-bar phrase", () => {
    const hits = barHits({ bar: 7, style: "rock", feel: 1, marks: [], endBeat: null });
    expect(hits.some((h) => h.step >= 8 && (h.drum === "tomL" || h.drum === "snare" || h.drum === "tomM"))).toBe(true);
    expect(hits.some((h) => h.drum === "hhc" && h.step >= 8)).toBe(false);
  });

  it("covers every style and feel", () => {
    for (const style of ["rock", "funk", "bossa", "lofi"] as const)
      for (const feel of [0, 1, 2] as const) {
        const hits = barHits({ bar: 1, style, feel, marks: [], endBeat: null });
        expect(hits.length).toBeGreaterThan(4);
        for (const h of hits) {
          expect(h.step).toBeGreaterThanOrEqual(0);
          expect(h.step).toBeLessThan(16);
        }
      }
  });
});

describe("strumming patterns and tempo changes (stress)", () => {
  function rnd(seed: number) {
    let s = seed;
    return () => {
      s = (s * 16807) % 2147483647;
      return s / 2147483647;
    };
  }
  /** Strums `pattern` (beat positions within a bar) over a plan of [bpm, bars]. */
  function play(seed: number, jitter: number, pattern: number[], plan: [number, number][]) {
    const r = rnd(seed);
    const strums: number[] = [];
    let t = 0;
    for (let k = 0; k < 4; k++) {
      strums.push(t + (r() * 2 - 1) * jitter);
      t += beatMs(plan[0][0]);
    }
    for (const [bpm, bars] of plan)
      for (let b = 0; b < bars; b++) {
        for (const f of pattern) strums.push(t + f * beatMs(bpm) + (r() * 2 - 1) * jitter);
        t += 4 * beatMs(bpm);
      }
    return simulate(strums, { latency: 30, rtt: 60, grid: 2 });
  }
  const patterns: Record<string, number[]> = {
    quarters: [0, 1, 2, 3],
    eighths: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5],
    "down down-up up-down-up": [0, 1, 1.5, 2.5, 3, 3.5],
    "half notes": [0, 2],
  };
  const plans: Record<string, [number, number][]> = {
    "steps of 6%": [[100, 3], [106, 3], [112, 3], [104, 3], [96, 3]],
    "jump 90→125": [[90, 4], [125, 6]],
  };
  for (const [pn, pattern] of Object.entries(patterns))
    for (const [plan, p] of Object.entries(plans))
      it(`${pn}, ${plan}: locked in again within 2 bars`, () => {
        for (const seed of [1, 2]) {
          const { offsets } = play(seed, 15, pattern, p);
          const n = pattern.length; // the last bar (each tempo lasts 3+ bars)
          expect(meanAbs(offsets.slice(-n).map((o) => o.ms))).toBeLessThan(30);
          expect(meanAbs(offsets.map((o) => o.ms))).toBeLessThan(45);
        }
      });
});
