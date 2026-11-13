// The room's drummer brain. Pure logic with no I/O: the server feeds it
// strums and clock ticks and broadcasts `state` whenever a method returns true.

import type { Feel, Mark, RoomState, Segment, Style } from "./protocol";
import { beatAtTime, beatMs, BEATS_PER_BAR, emptyTransport, segmentAtTime, timeOfBeat } from "./transport";
import { clampBpm, detectCountIn, fitGrid, foldBpm } from "./tempo";

const DEFAULT_BPM = 100;
/** Bars of silence before the drummer plays an ending. */
const SILENCE_BARS = 2;
/** A chord held at least this many bars earns a fill when it changes. */
const LONG_HOLD_BARS = 2;
/** Tempo changes smaller than this are ignored, so the drummer doesn't wobble. */
const BPM_DEADBAND = 0.008;
/** Phase drift (ms) worth correcting at the next bar. */
const PHASE_DEADBAND = 8;
/** How much of the measured phase drift is corrected per beat. */
const PHASE_GAIN = 0.85;
/** Most a single beat can be nudged, as a fraction of a beat. */
const PHASE_LIMIT = 0.2;
/** A steady run of strums this far off the drummer's tempo (10%) triggers a resync. */
const RESYNC_JUMP = 0.1;
/** Strums from this many bars back are used to read tempo. */
const FIT_BARS = 2;
/** Grid history kept in the state (must cover FIT_BARS at the slowest tempo). */
const KEEP_MS = 9000;

export function initialState(): RoomState {
  return {
    players: [],
    style: "rock",
    bpm: DEFAULT_BPM,
    follow: true,
    chord: null,
    feel: 1,
    transport: emptyTransport(),
    status: "",
  };
}

export class Conductor {
  state: RoomState;
  /** Recent strum times (shared ms). */
  private onsets: number[] = [];
  private lastStrumAt = 0;
  private chordSince = 0;
  private energy = 0.5;
  private strumsSinceStart = 0;
  /**
   * How long drum phones can take to notice a change (their polling
   * interval). Added to every booking margin.
   */
  pollMs = 0;
  /** Time a tempo-jump resync lands; following pauses until then. */
  private resyncAt: number | null = null;

  constructor(state: RoomState = initialState()) {
    this.state = state;
    this.updateStatus();
  }

  // ---- timing helpers -------------------------------------------------

  /** Worst round-trip time reported by any phone. */
  private maxRtt() {
    return this.state.players.reduce((m, p) => Math.max(m, p.rtt || 0), 0);
  }

  /** How far ahead changes are booked: 1 beat, or 2 on slow connections. */
  leadMs(bpm = this.currentBpm()) {
    const beats = this.maxRtt() > 200 ? 2 : 1;
    return Math.max(beats * beatMs(bpm), this.lockMs() + 60);
  }

  /**
   * A booked change closer than this can no longer be edited: drum phones
   * may already have scheduled it (they book ~150 ms ahead, plus network).
   */
  private lockMs() {
    return 250 + this.maxRtt() + this.pollMs;
  }

  /** How far ahead the very first downbeat must be. */
  private startLeadMs() {
    return this.lockMs();
  }

  private currentBpm() {
    const segs = this.state.transport.segments;
    return segs.length ? segs[segs.length - 1].bpm : this.state.bpm;
  }

  private get t() {
    return this.state.transport;
  }

  // ---- inputs ---------------------------------------------------------

  strum(now: number, at: number, chord: string, strength: number): boolean {
    let changed = false;
    // Strums timestamped far from "now" are bogus (bad clock sync); clamp.
    if (Math.abs(at - now) > 2000) at = now;

    // Drop stale onsets so an old phrase doesn't pollute a new count-in.
    this.onsets = this.onsets.filter((t) => at - t < 6000 && t < at);
    this.onsets.push(at);
    if (this.onsets.length > 16) this.onsets.shift();
    this.lastStrumAt = at;
    this.strumsSinceStart++;

    changed = this.updateFeel(strength) || changed;

    // Chord change
    if (chord !== this.state.chord) {
      const prevHeld = this.state.chord !== null ? at - this.chordSince : 0;
      this.state.chord = chord;
      this.chordSince = at;
      changed = true;
      if (this.t.playing && this.t.endBeat === null) {
        const longHold = LONG_HOLD_BARS * BEATS_PER_BAR * beatMs(this.currentBpm());
        if (prevHeld >= longHold) this.addChangeFill(now);
      }
    }

    if (this.t.playing && this.t.endBeat !== null) {
      // Strumming during an ending: cancel it if the fill hasn't started yet.
      const fillStart = timeOfBeat(this.t.segments, this.t.endBeat - 2);
      if (fillStart > now + this.leadMs()) {
        this.cancelEnding();
        changed = true;
      } else {
        this.onsets = [at];
      }
      return changed;
    }

    if (!this.t.playing) {
      if (this.state.follow) {
        const ci = detectCountIn(this.onsets);
        if (ci) {
          this.state.bpm = round1(clampBpm(ci.bpm));
          const barMs = BEATS_PER_BAR * ci.period;
          let t0 = ci.firstBeat + barMs;
          while (t0 < now + this.startLeadMs()) t0 += barMs;
          this.begin(t0);
          changed = true;
        }
      }
      return changed;
    }

    if (this.state.follow) {
      changed = this.followStrums(now) || changed;
    } else if (changed) {
      this.commit(now, BEATS_PER_BAR);
    }
    return changed;
  }

  setStyle(now: number, style: Style) {
    if (style === this.state.style) return false;
    this.state.style = style;
    if (this.t.playing) this.commit(now, BEATS_PER_BAR);
    return true;
  }

  setBpm(now: number, bpm: number) {
    this.state.bpm = round1(clampBpm(bpm));
    if (this.t.playing) this.commit(now, BEATS_PER_BAR);
    return true;
  }

  setFollow(follow: boolean) {
    this.state.follow = follow;
    this.updateStatus();
    return true;
  }

  /** Start the drummer by button, at the current BPM. */
  start(now: number) {
    if (this.t.playing && this.t.endBeat === null) return false;
    this.begin(now + this.leadMs(this.state.bpm));
    this.strumsSinceStart = 0;
    return true;
  }

  /** Play a fill and finish. */
  stop(now: number) {
    if (!this.t.playing || this.t.endBeat !== null) return false;
    this.scheduleEnding(now);
    return true;
  }

  /** Called a few times a second. Handles silence and wrapping up. */
  tick(now: number): boolean {
    const t = this.t;
    if (!t.playing) return false;
    if (t.endBeat !== null) {
      if (now > timeOfBeat(t.segments, t.endBeat) + 1500) {
        this.state.transport = emptyTransport(t.epoch);
        this.onsets = [];
        this.resyncAt = null;
        this.updateStatus();
        return true;
      }
      return false;
    }
    if (this.state.follow && this.strumsSinceStart > 0) {
      const barMs = BEATS_PER_BAR * beatMs(this.currentBpm());
      const silence = Math.min(5000, Math.max(2500, SILENCE_BARS * barMs));
      if (now - this.lastStrumAt > silence) {
        this.scheduleEnding(now);
        return true;
      }
    }
    // Forget marks that are long gone.
    const before = t.marks.length;
    t.marks = t.marks.filter((m) => timeOfBeat(t.segments, m.beat) > now - 4000);
    return t.marks.length !== before;
  }

  // ---- internals ------------------------------------------------------

  private begin(t0: number) {
    const epoch = this.t.epoch + 1;
    const seg: Segment = {
      beat: 0,
      time: t0,
      bpm: this.state.bpm,
      style: this.state.style,
      feel: this.state.feel,
    };
    this.state.transport = {
      epoch,
      playing: true,
      segments: [seg],
      marks: [{ kind: "crash", beat: 0 }],
      endBeat: null,
    };
    this.strumsSinceStart = 1;
    this.updateStatus();
  }

  private followStrums(now: number): boolean {
    const lead = this.leadMs();
    const lock = now + this.lockMs();
    const frozen = this.t.segments.filter((s) => s.time < lock);
    if (!frozen.length) return false;
    // Waiting for a resync to lock in: the old grid can't explain the new
    // strums, and a nudge now would overwrite the resync.
    if (this.resyncAt !== null && this.resyncAt >= lock) return false;

    const last = frozen[frozen.length - 1];
    const period = beatMs(last.bpm);

    // 1. A clear jump in tempo: the last 4 strums are steady at a tempo far
    //    from the drummer's. Re-count like a count-in and jump to it.
    const ci = detectCountIn(this.onsets, 4, 0.1);
    if (ci) {
      const raw = 60000 / ci.rawPeriod;
      // Same tempo in 8ths (or halves)? Read it that way. Otherwise a real
      // jump: fold it into the normal range like a count-in.
      const near = nearestOctave(raw, last.bpm);
      const bpm = clampBpm(Math.abs(Math.log(near / last.bpm)) < Math.log(1.2) ? near : foldBpm(raw));
      if (Math.abs(bpm - last.bpm) / last.bpm > RESYNC_JUMP) {
        this.state.bpm = round1(bpm);
        const p = beatMs(this.state.bpm);
        const newest = this.onsets[this.onsets.length - 1];
        this.commit(now, BEATS_PER_BAR, (_beat, gridTime) => {
          // Land the bar line on the guitarist's beat nearest the old bar line.
          let tB = newest + Math.round((gridTime - newest) / p) * p;
          while (tB < now + lead) tB += p;
          return tB - gridTime;
        });
        const seg = this.t.segments[this.t.segments.length - 1];
        this.resyncAt = seg.time;
        // Strums from before the jump belong to the old grid; start fresh.
        this.onsets = [];
        return true;
      }
    }

    // 2. Normal following: fit a line through recent strums and nudge the
    //    next free beat toward it (tempo and phase).
    const window = FIT_BARS * BEATS_PER_BAR * period;
    // Strums from before a resync landed were played against a different grid.
    const floor = this.resyncAt !== null ? this.resyncAt - period / 2 : -Infinity;
    const recent = this.onsets.filter((t) => t > now - window && t > floor).slice(-10);
    const fit = fitGrid(recent, (t) => beatAtTime(frozen, t), period);

    let changed = false;
    if (fit) {
      const bpm = clampBpm(60000 / fit.period);
      if (Math.abs(bpm - this.state.bpm) / this.state.bpm > BPM_DEADBAND) {
        this.state.bpm = round1(bpm);
        changed = true;
      }
    }
    const shiftFor = (beat: number, gridTime: number) => {
      if (!fit) return 0;
      const drift = fit.at(beat) - gridTime;
      if (Math.abs(drift) < PHASE_DEADBAND) return 0;
      const lim = period * PHASE_LIMIT;
      return Math.max(-lim, Math.min(lim, drift * PHASE_GAIN));
    };
    // Always re-book the next free beat from the latest strums (it's cheap and
    // only touches the part of the grid nobody has played yet).
    const before = JSON.stringify(this.t.segments);
    this.commit(now, 1, shiftFor);
    return changed || JSON.stringify(this.t.segments) !== before;
  }

  /**
   * Books the current target tempo / style / feel at the next line of the
   * grid (every `grain` beats: 4 = bar line) that is at least one lead time
   * away. A change that is already booked but not yet locked is updated in
   * place rather than pushed further out (otherwise frequent strums would keep
   * postponing it forever). Anything inside the lock window stays put.
   * Style and feel are read at bar lines, so they always change on a bar.
   */
  private commit(
    now: number,
    grain: number = BEATS_PER_BAR,
    shiftFor?: (beat: number, gridTime: number) => number,
  ) {
    const t = this.t;
    if (!t.playing || t.endBeat !== null) return;
    const lead = this.leadMs();
    const lock = now + this.lockMs();
    let frozen = t.segments.filter((s) => s.time < lock);
    const pending = t.segments.find((s) => s.time >= lock);
    if (!frozen.length) {
      // Hasn't started yet: just restyle the first segment in place.
      const first = t.segments[0];
      t.segments = [
        { ...first, bpm: this.state.bpm, style: this.state.style, feel: this.state.feel },
      ];
      return;
    }
    // Keep the segments covering the strums the tempo fit still looks at.
    const active = segmentAtTime(frozen, now - KEEP_MS);
    frozen = frozen.slice(frozen.indexOf(active));
    const last = frozen[frozen.length - 1];
    let beat = Math.ceil(beatAtTime(frozen, now + lead) / grain) * grain;
    if (pending && pending.beat < beat && pending.beat % grain === 0) beat = pending.beat;
    if (beat <= last.beat) beat = Math.ceil((last.beat + 1) / grain) * grain;
    const gridTime = timeOfBeat(frozen, beat);
    const next: Segment = {
      beat,
      time: Math.max(lock, gridTime + (shiftFor ? shiftFor(beat, gridTime) : 0)),
      bpm: this.state.bpm,
      style: this.state.style,
      feel: this.state.feel,
    };
    const same =
      Math.abs(next.time - gridTime) < 1 &&
      next.bpm === last.bpm &&
      next.style === last.style &&
      next.feel === last.feel;
    t.segments = same ? frozen : [...frozen, next];
  }

  private updateFeel(strength: number): boolean {
    this.energy = this.energy * 0.7 + Math.max(0, Math.min(1, strength)) * 0.3;
    const e = this.energy;
    let feel: Feel = this.state.feel;
    if (feel === 1) {
      if (e > 0.68) feel = 2;
      else if (e < 0.3) feel = 0;
    } else if (feel === 2) {
      if (e < 0.58) feel = e < 0.3 ? 0 : 1;
    } else {
      if (e > 0.4) feel = e > 0.68 ? 2 : 1;
    }
    if (feel !== this.state.feel) {
      this.state.feel = feel;
      return true;
    }
    return false;
  }

  /** First whole beat that can still be changed. */
  private firstFreeBeat(now: number) {
    return Math.ceil(beatAtTime(this.t.segments, now + this.leadMs()));
  }

  private addChangeFill(now: number) {
    const b = this.firstFreeBeat(now);
    const pos = ((b % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR;
    let mark: Mark;
    if (pos === 0) mark = { kind: "crash", beat: b };
    else mark = { kind: "fill", beat: pos === 1 ? b + 1 : b };
    const bar = Math.floor(mark.beat / BEATS_PER_BAR);
    const clash = this.t.marks.some((m) => Math.floor(m.beat / BEATS_PER_BAR) === bar);
    if (!clash) this.t.marks.push(mark);
  }

  private scheduleEnding(now: number) {
    const t = this.t;
    // Drop any pending tempo change; end on the grid that's already booked.
    const lead = this.leadMs();
    const frozen = t.segments.filter((s) => s.time < now + lead);
    if (frozen.length) t.segments = frozen;
    const nb = beatAtTime(t.segments, now + lead);
    const end = Math.ceil((nb + 2) / BEATS_PER_BAR) * BEATS_PER_BAR;
    t.marks = t.marks.filter((m) => m.beat < end - 2);
    t.marks.push({ kind: "fill", beat: end - 2 });
    t.endBeat = end;
    this.updateStatus();
  }

  private cancelEnding() {
    const t = this.t;
    if (t.endBeat === null) return;
    const end = t.endBeat;
    t.marks = t.marks.filter((m) => !(m.kind === "fill" && m.beat === end - 2));
    t.endBeat = null;
    this.updateStatus();
  }

  private updateStatus() {
    const t = this.t;
    if (t.playing && t.endBeat !== null) this.state.status = "Ending…";
    else if (t.playing) this.state.status = this.state.follow ? "Following your strums" : "Drums on";
    else if (this.state.follow) this.state.status = "Strum 4 steady beats to count in";
    else this.state.status = "Press Start drums";
  }
}

/** The tempo among bpm × 2ⁿ closest to `ref` (so 8th-note strumming reads as the same tempo). */
function nearestOctave(bpm: number, ref: number) {
  let best = bpm;
  for (const k of [0.25, 0.5, 1, 2, 4]) {
    const c = bpm * k;
    if (Math.abs(Math.log(c / ref)) < Math.abs(Math.log(best / ref))) best = c;
  }
  return best;
}

function round1(x: number) {
  return Math.round(x * 10) / 10;
}
