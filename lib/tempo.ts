// Reads tempo from the gaps between strums.

/**
 * Each newer strum counts this much more than the one before in the tempo
 * fit. Higher follows tempo changes faster; lower is calmer on sloppy timing.
 * Tuned against simulated players (see test/conductor.test.ts).
 */
const WEIGHT_GROWTH = 1.8;

export const MIN_BPM = 60;
export const MAX_BPM = 180;
/** Count-in tempos are folded into this range (so 8th-note strums read as quarter notes). */
const FOLD_LOW = 70;
const FOLD_HIGH = 160;

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function clampBpm(bpm: number) {
  return Math.min(MAX_BPM, Math.max(MIN_BPM, bpm));
}

/** Double or halve a tempo until it sits in the comfortable range. */
export function foldBpm(bpm: number): number {
  while (bpm >= FOLD_HIGH) bpm /= 2;
  while (bpm < FOLD_LOW) bpm *= 2;
  return bpm;
}

export type CountIn = {
  bpm: number;
  /** Beat period in ms */
  period: number;
  /** Time of the strum treated as beat 1 of the count-in bar. */
  firstBeat: number;
  /** Gap between the strums, before folding. */
  rawPeriod: number;
};

/**
 * Looks for a count-in: the last `n` strums evenly spaced.
 * Returns the tempo and where beat 1 was, or null if the strums aren't steady.
 */
export function detectCountIn(onsets: number[], n = 4, tolerance = 0.18): CountIn | null {
  if (onsets.length < n) return null;
  const run = onsets.slice(-n);
  const gaps: number[] = [];
  for (let i = 1; i < run.length; i++) gaps.push(run[i] - run[i - 1]);
  const med = median(gaps);
  if (med < 150 || med > 1500) return null;
  if (gaps.some((g) => Math.abs(g - med) / med > tolerance)) return null;
  // Least-squares fit of a straight line through the strums for a steadier period.
  const period = fitPeriod(run) ?? med;
  const raw = 60000 / period;
  const bpm = foldBpm(raw);
  const beatPeriod = 60000 / bpm;
  return { bpm, period: beatPeriod, firstBeat: run[0], rawPeriod: period };
}

/** Slope of the best-fit line through evenly indexed onsets. */
function fitPeriod(run: number[]): number | null {
  const n = run.length;
  if (n < 2) return null;
  const xm = (n - 1) / 2;
  const ym = run.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xm) * (run[i] - ym);
    den += (i - xm) * (i - xm);
  }
  return num / den;
}

export type GridFit = {
  /** Fitted beat period (ms). */
  period: number;
  /** Where the guitarist's timing puts beat `b` (shared ms). */
  at: (beat: number) => number;
  points: number;
};

/**
 * Fits a straight line through recent strums against beat numbers on the
 * drummer's grid: time = a + period * beat.
 *
 * Strums are numbered by counting 8th notes from the strum before, so the
 * numbering survives even when the guitarist has drifted far from the drums.
 * The chain is then pinned to the grid at whichever alignment puts the most
 * strums on a beat (not on an "and").
 * Recent strums weigh more, so the fit follows a speed-up quickly.
 */
export function fitGrid(
  onsets: number[],
  beatOf: (t: number) => number,
  period: number,
): GridFit | null {
  let qs: number[] = [];
  let ts: number[] = [];
  const restart = (t: number) => {
    qs = [0];
    ts = [t];
  };
  for (const t of onsets) {
    if (!ts.length) {
      restart(t);
      continue;
    }
    const n = ts.length;
    // Running period: from the chain itself once it's long enough.
    const span = qs[n - 1] - qs[0];
    const p = n >= 3 && span >= 1.5 ? (ts[n - 1] - ts[0]) / span : period;
    const gap = t - ts[n - 1];
    const r = gap / (p / 2); // gap in 8th notes
    const k = Math.round(r);
    if (k < 1) continue; // two hits on one 8th: keep the first
    if (k > 8 || Math.abs(r - k) / k > 0.22 || Math.abs(r - k) > 0.4) {
      restart(t); // lost the thread (long pause or a stumble)
      continue;
    }
    qs.push(qs[n - 1] + k / 2);
    ts.push(t);
  }
  const n = qs.length;
  if (n < 4 || qs[n - 1] - qs[0] < 2) return null;
  // Pin the chain to the grid: try each whole/half-beat offset suggested by
  // the strums and keep the one that fits best, newest strums counting most,
  // with a small preference for strums landing on the beat over the "and".
  const bs = ts.map(beatOf);
  let k0 = 0;
  let best = Infinity;
  const cands = new Set(bs.map((b, i) => Math.round((b - qs[i]) * 2) / 2));
  for (const k of cands) {
    let cost = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.pow(WEIGHT_GROWTH, i);
      cost += w * Math.min(0.5, Math.abs(bs[i] - (qs[i] + k)));
      if (!Number.isInteger(qs[i] + k)) cost += w * 0.2;
    }
    if (cost < best) {
      best = cost;
      k0 = k;
    }
  }
  qs = qs.map((q) => q + k0);
  // Weighted least squares, weights growing geometrically toward the newest strum.
  let sw = 0, sq = 0, st = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.pow(WEIGHT_GROWTH, i);
    sw += w;
    sq += w * qs[i];
    st += w * ts[i];
  }
  const qm = sq / sw;
  const tm = st / sw;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.pow(WEIGHT_GROWTH, i);
    num += w * (qs[i] - qm) * (ts[i] - tm);
    den += w * (qs[i] - qm) ** 2;
  }
  const p = num / den;
  if (!(p > period * 0.7 && p < period * 1.4)) return null;
  const a = tm - p * qm;
  return { period: p, at: (beat) => a + p * beat, points: n };
}
