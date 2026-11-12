"use client";

// Everything that touches Tone.js lives behind a dynamic import of this file,
// so it never runs during server rendering.

import * as Tone from "tone";
import { VOICINGS, type ChordName } from "../chords";
import type { Mark, Segment, Style, Transport } from "../protocol";
import { barHits, SWING, type Drum, type Hit } from "../patterns";
import { BEATS_PER_BAR, beatAtTime, segmentAtBeat, timeOfBeat } from "../transport";
import type { ClockSync } from "./connection";

let started = false;

/**
 * Must be called from a tap. Unlocks audio on iPhone and asks Safari to play
 * even when the silent switch is on.
 */
export async function unlockAudio() {
  if (!started) {
    Tone.setContext(new Tone.Context({ latencyHint: "interactive", lookAhead: 0 }));
    started = true;
  }
  // Safari 16.4+: "playback" ignores the ringer switch.
  const nav = navigator as Navigator & { audioSession?: { type: string } };
  if (nav.audioSession) {
    try {
      nav.audioSession.type = "playback";
    } catch {}
  }
  await Tone.start();
  // A silent blip makes iOS fully wake the output.
  const raw = Tone.getContext().rawContext as AudioContext;
  const buf = raw.createBuffer(1, 1, raw.sampleRate);
  const src = raw.createBufferSource();
  src.buffer = buf;
  src.connect(raw.destination);
  src.start();
}

function raw() {
  return Tone.getContext().rawContext as AudioContext;
}

/** Seconds between scheduling a sound and hearing it. */
export function outputLatency() {
  const c = raw();
  return (c.outputLatency || 0) + (c.baseLatency || 0);
}

/**
 * Converts a time on the room clock into this phone's audio clock, so a sound
 * scheduled there comes out of the speaker at that shared moment.
 * `delayMs` is extra compensation for Bluetooth speakers.
 */
export function sharedToAudio(clock: ClockSync, shared: number, delayMs = 0): number {
  const c = raw();
  const perfTarget = shared - clock.offset - performance.timeOrigin - delayMs;
  const ts = typeof c.getOutputTimestamp === "function" ? c.getOutputTimestamp() : null;
  if (ts && ts.performanceTime && ts.contextTime) {
    // contextTime is what's leaving the speaker at performanceTime: this
    // accounts for output latency automatically.
    return ts.contextTime + (perfTarget - ts.performanceTime) / 1000;
  }
  return c.currentTime + (perfTarget - performance.now()) / 1000 - outputLatency();
}

/** The shared time at which something played right now would be heard. */
export function heardNow(clock: ClockSync, delayMs = 0) {
  return clock.now() + outputLatency() * 1000 + delayMs;
}

// ---------------------------------------------------------------------------
// Guitar

export class Guitar {
  private strings: { synth: Tone.PluckSynth; gain: Tone.Gain }[] = [];
  private out: Tone.Volume;

  constructor() {
    const reverb = new Tone.Reverb({ decay: 1.8, wet: 0.18 }).toDestination();
    const comp = new Tone.Compressor({ threshold: -18, ratio: 3 }).connect(reverb);
    const body = new Tone.Filter({ type: "peaking", frequency: 220, Q: 0.8, gain: 4 }).connect(comp);
    const tone = new Tone.Filter({ type: "lowpass", frequency: 4200, rolloff: -12 }).connect(body);
    this.out = new Tone.Volume(-4).connect(tone);
    for (let i = 0; i < 6; i++) {
      const gain = new Tone.Gain(0.8).connect(this.out);
      const synth = new Tone.PluckSynth({ attackNoise: 1.2, dampening: 3800, resonance: 0.985, release: 1 }).connect(gain);
      this.strings.push({ synth, gain });
    }
  }

  /** Strum a chord now. Harder = louder, tighter and brighter. */
  strum(chord: ChordName, dir: "down" | "up", strength: number) {
    const notes = VOICINGS[chord];
    const s = Math.max(0.05, Math.min(1, strength));
    const spread = 0.028 - s * 0.02; // seconds between strings
    const t0 = Tone.now() + 0.005;
    let order = notes.map((n, i) => ({ n, i })).filter((x) => x.n !== null);
    if (dir === "up") order = order.reverse().slice(0, 4); // upstrokes catch the top strings
    order.forEach(({ n, i }, k) => {
      const t = t0 + k * spread;
      const str = this.strings[i];
      const vel = (0.35 + s * 0.65) * (dir === "up" ? 0.8 : 1);
      str.gain.gain.setValueAtTime(vel, t);
      str.synth.triggerAttack(Tone.Frequency(n!, "midi").toFrequency(), t);
    });
  }

  /** Damp all strings (palm mute / stop). */
  mute() {
    const t = Tone.now();
    this.strings.forEach((s) => s.gain.gain.rampTo(0, 0.05, t));
  }
}

// ---------------------------------------------------------------------------
// Drums (synthesised, so there's nothing to download)

type Voice = (time: number, vel: number) => void;

export class DrumKit {
  private voices: Record<Drum, Voice>;
  private tone: Tone.Filter;
  private lastStyle: Style | null = null;

  constructor() {
    const master = new Tone.Compressor({ threshold: -14, ratio: 4, attack: 0.003, release: 0.15 }).toDestination();
    const room = new Tone.Reverb({ decay: 0.9, wet: 0.08 }).connect(master);
    this.tone = new Tone.Filter({ type: "lowpass", frequency: 18000 }).connect(room);
    const bus = new Tone.Volume(-2).connect(this.tone);

    const kick = new Tone.MembraneSynth({
      pitchDecay: 0.045,
      octaves: 7,
      oscillator: { type: "sine" },
      envelope: { attack: 0.001, decay: 0.38, sustain: 0, release: 0.05 },
    }).connect(bus);
    kick.volume.value = 2;

    const snareBody = new Tone.MembraneSynth({
      pitchDecay: 0.02,
      octaves: 2,
      envelope: { attack: 0.001, decay: 0.12, sustain: 0, release: 0.02 },
    }).connect(bus);
    snareBody.volume.value = -8;
    const snareHp = new Tone.Filter({ type: "highpass", frequency: 1200 }).connect(bus);
    const snareNoise = new Tone.NoiseSynth({
      noise: { type: "white" },
      envelope: { attack: 0.001, decay: 0.17, sustain: 0, release: 0.03 },
    }).connect(snareHp);
    snareNoise.volume.value = -3;

    const rim = new Tone.MembraneSynth({
      pitchDecay: 0.005,
      octaves: 1.5,
      envelope: { attack: 0.0005, decay: 0.04, sustain: 0, release: 0.01 },
    }).connect(new Tone.Filter({ type: "bandpass", frequency: 1800, Q: 2 }).connect(bus));
    rim.volume.value = 6;

    const hatHp = new Tone.Filter({ type: "highpass", frequency: 7500 }).connect(bus);
    const hhc = new Tone.NoiseSynth({ noise: { type: "white" }, envelope: { attack: 0.001, decay: 0.04, sustain: 0, release: 0.01 } }).connect(hatHp);
    hhc.volume.value = -9;
    const hho = new Tone.NoiseSynth({ noise: { type: "white" }, envelope: { attack: 0.002, decay: 0.32, sustain: 0, release: 0.08 } }).connect(hatHp);
    hho.volume.value = -11;

    const crashHp = new Tone.Filter({ type: "highpass", frequency: 4200 }).connect(bus);
    const crash = new Tone.NoiseSynth({ noise: { type: "white" }, envelope: { attack: 0.002, decay: 1.4, sustain: 0, release: 0.4 } }).connect(crashHp);
    crash.volume.value = -9;
    const crashShimmer = new Tone.MetalSynth({
      envelope: { attack: 0.001, decay: 1.2, release: 0.3 },
      harmonicity: 5.1,
      modulationIndex: 40,
      resonance: 5000,
      octaves: 1.5,
    }).connect(crashHp);
    crashShimmer.volume.value = -26;

    const tom = (note: string) => {
      const s = new Tone.MembraneSynth({
        pitchDecay: 0.06,
        octaves: 2.2,
        envelope: { attack: 0.001, decay: 0.32, sustain: 0, release: 0.05 },
      }).connect(bus);
      s.volume.value = -3;
      return (t: number, v: number) => s.triggerAttackRelease(note, 0.3, t, v);
    };

    const shakerBp = new Tone.Filter({ type: "bandpass", frequency: 5500, Q: 1.2 }).connect(bus);
    const shaker = new Tone.NoiseSynth({ noise: { type: "pink" }, envelope: { attack: 0.006, decay: 0.05, sustain: 0, release: 0.02 } }).connect(shakerBp);
    shaker.volume.value = -12;

    this.voices = {
      kick: (t, v) => kick.triggerAttackRelease("C1", 0.3, t, v),
      snare: (t, v) => {
        snareBody.triggerAttackRelease("G2", 0.1, t, v);
        snareNoise.triggerAttackRelease(0.15, t, v);
      },
      rim: (t, v) => rim.triggerAttackRelease("E5", 0.04, t, v),
      hhc: (t, v) => hhc.triggerAttackRelease(0.04, t, v),
      hho: (t, v) => hho.triggerAttackRelease(0.3, t, v),
      crash: (t, v) => {
        crash.triggerAttackRelease(1.2, t, v);
        crashShimmer.triggerAttackRelease(300, 1, t, v * 0.6);
      },
      tomH: tom("A2"),
      tomM: tom("E2"),
      tomL: tom("A1"),
      shaker: (t, v) => shaker.triggerAttackRelease(0.05, t, v),
    };
  }

  play(drum: Drum, time: number, vel: number) {
    try {
      this.voices[drum](time, vel);
    } catch {
      // A voice can refuse a start time that isn't after its last one; skip that hit.
    }
  }

  /** Lo-fi gets a darker, dustier kit. Switched on the bar line. */
  setStyle(style: Style, time: number) {
    if (style === this.lastStyle) return;
    this.lastStyle = style;
    this.tone.frequency.setValueAtTime(style === "lofi" ? 3200 : 18000, time);
  }
}

/**
 * Plays the shared drum grid. Every 25 ms it books the 16th notes falling in
 * the next ~150 ms onto the audio clock. Since every drum phone runs the same
 * deterministic patterns against the same room clock, they all play in unison.
 */
export class DrumScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextStep: number | null = null;
  private epoch = -1;
  transport: Transport | null = null;
  delayMs = 0;

  constructor(
    private kit: DrumKit,
    private clock: ClockSync,
  ) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 25);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick() {
    const t = this.transport;
    if (!t || !t.playing || !t.segments.length) {
      this.nextStep = null;
      return;
    }
    const now = this.clock.now();
    const horizon = now + 150 + this.delayMs;
    if (t.epoch !== this.epoch || this.nextStep === null) {
      this.epoch = t.epoch;
      // Join at the next 16th that hasn't passed (works when joining mid-jam).
      const b = Math.max(0, beatAtTime(t.segments, now + this.delayMs));
      this.nextStep = t.segments[0].time > now ? 0 : Math.ceil(b * 4);
    }
    const segs = t.segments;
    for (let guard = 0; guard < 64; guard++) {
      const step: number = this.nextStep!;
      const beat = step / 4;
      if (timeOfBeat(segs, beat) > horizon) break;
      if (t.endBeat !== null && beat > t.endBeat) break;
      this.playStep(step, segs, t.marks, t.endBeat, now);
      this.nextStep = step + 1;
    }
  }

  private playStep(step: number, segs: Segment[], marks: Mark[], endBeat: number | null, now: number) {
    const bar = Math.floor(step / 16);
    const inBar = step - bar * 16;
    const barBeat = bar * BEATS_PER_BAR;
    const seg = segmentAtBeat(segs, barBeat);
    const hits = this.hitsFor(bar, seg, marks, endBeat).filter((h) => Math.floor(h.step) === inBar);
    if (inBar === 0) this.kit.setStyle(seg.style, sharedToAudio(this.clock, timeOfBeat(segs, barBeat), this.delayMs));
    const swing = SWING[seg.style];
    for (const h of hits) {
      let pos = h.step;
      if (Math.floor(pos) % 2 === 1) pos += (swing - 0.5) * 2;
      const shared = timeOfBeat(segs, barBeat + pos / 4);
      if (shared < now - 30) continue; // too late to play in time
      this.kit.play(h.drum, sharedToAudio(this.clock, shared, this.delayMs), h.vel);
      debugHook()?.onHit?.(h.drum, shared, h.vel);
    }
  }

  private cacheKey = "";
  private cacheHits: Hit[] = [];
  private hitsFor(bar: number, seg: Segment, marks: Mark[], endBeat: number | null): Hit[] {
    const key = `${this.epoch}:${bar}:${seg.style}:${seg.feel}:${endBeat}:${marks.map((m) => m.kind + m.beat).join(",")}`;
    if (key !== this.cacheKey) {
      this.cacheKey = key;
      this.cacheHits = dedupe(barHits({ bar, style: seg.style, feel: seg.feel, marks, endBeat }));
    }
    return this.cacheHits;
  }
}

type DebugHook = {
  onHit?: (drum: Drum, sharedTime: number, vel: number) => void;
  onStrum?: (sharedTime: number) => void;
};
/** Test-only: set `window.__jamDebug` to observe timing. Does nothing otherwise. */
export function debugHook(): DebugHook | undefined {
  return (globalThis as { __jamDebug?: DebugHook }).__jamDebug;
}

/** One hit per drum per position (the loudest), so no voice is triggered twice at once. */
function dedupe(hits: Hit[]): Hit[] {
  const m = new Map<string, Hit>();
  for (const h of hits) {
    const k = `${h.drum}@${h.step}`;
    const prev = m.get(k);
    if (!prev || prev.vel < h.vel) m.set(k, h);
  }
  return [...m.values()].sort((a, b) => a.step - b.step);
}
