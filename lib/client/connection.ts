"use client";

import { Conductor, initialState } from "../conductor";
import type { ClientMessage, Player, Role, RoomState } from "../protocol";
import { STYLES } from "../protocol";

/** Wall-clock ms with sub-ms precision that never jumps backwards. */
export function localNow() {
  return performance.timeOrigin + performance.now();
}

type Sample = { rtt: number; offset: number };

/**
 * Estimates the offset between this phone's clock and the room server's
 * (NTP-style). Keeps the samples with the lowest round trip, which are the
 * most accurate. Every poll is a sample, so it keeps improving.
 */
export class ClockSync {
  private samples: Sample[] = [];
  offset = 0;
  rtt = 0;
  synced = false;

  add(t0: number, serverTs: number, t1: number) {
    const rtt = t1 - t0;
    const offset = serverTs - (t0 + rtt / 2);
    this.samples.push({ rtt, offset });
    if (this.samples.length > 24) this.samples.shift();
    const best = [...this.samples].sort((a, b) => a.rtt - b.rtt).slice(0, 3);
    this.offset = best.reduce((s, x) => s + x.offset, 0) / best.length;
    this.rtt = best[0].rtt;
    this.synced = this.samples.length >= 4;
  }

  /** Current time on the room server's clock. */
  now() {
    return localNow() + this.offset;
  }
}

/** How often drum phones check for changes while the drums play. */
export const POLL_MS = 200;
const POLL_IDLE_MS = 700;
const HEARTBEAT_MS = 4000;

/** What the guitar phone publishes. */
type PublishedRoom = { rev: number; state: RoomState };

type Listener = () => void;

/**
 * One phone's link to a room, over plain HTTP so it runs entirely on Vercel.
 *
 * The guitar phone is the room's brain: it runs the Conductor locally (strums
 * never leave the phone) and publishes the room whenever it changes. Every
 * other phone polls for it. Polls double as clock-sync samples.
 */
export class RoomConnection {
  clock = new ClockSync();
  state: RoomState | null = null;
  readonly you = randomId();
  connected = false;
  /** Set when the server says it can't run rooms (e.g. storage not set up). */
  error: string | null = null;

  private role: Role = "listener";
  private conductor: Conductor | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private players: Player[] = [];
  private remote: PublishedRoom | null = null;
  private listeners = new Set<Listener>();
  private closed = false;
  private publishing = false;
  private dirty = false;
  private polls = 0;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly url: string;

  constructor(readonly roomId: string) {
    this.url = `/api/room/${encodeURIComponent(roomId)}`;
    this.state = withPlayers(initialState(), []);
    this.pollLoop();
    this.heartbeat();
    window.addEventListener("pagehide", this.onLeave);
  }

  // ---- inputs -------------------------------------------------------------

  setRole(role: Role) {
    this.role = role;
    if (role === "guitar" && !this.conductor) {
      // Pick up where the room is (e.g. after a reload) or start fresh.
      // A new room starts in auto-jam: press Play and it plays itself.
      const base = this.remote
        ? structuredClone(this.remote.state)
        : { ...initialState(), auto: true, follow: false };
      this.conductor = new Conductor(base);
      this.conductor.pollMs = POLL_MS;
      this.conductor.state.players = this.players;
      this.tickTimer = setInterval(() => {
        if (this.conductor?.tick(this.clock.now())) this.publish();
      }, 100);
      this.state = { ...this.conductor.state };
      this.publish();
    } else if (role !== "guitar" && this.conductor) {
      this.conductor = null;
      if (this.tickTimer) clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.heartbeat();
    this.emit();
  }

  /** Guitar-phone actions. Other phones can't change the room. */
  send(msg: ClientMessage) {
    const c = this.conductor;
    if (!c) return;
    const now = this.clock.now();
    let changed = false;
    switch (msg.type) {
      case "strum":
        changed = c.strum(now, msg.at, msg.chord, msg.strength);
        break;
      case "style":
        if (STYLES.includes(msg.style)) changed = c.setStyle(now, msg.style);
        break;
      case "bpm":
        changed = c.setBpm(now, msg.bpm);
        break;
      case "follow":
        changed = c.setFollow(msg.follow);
        break;
      case "start":
        changed = c.start(now);
        break;
      case "stop":
        changed = c.stop(now);
        break;
      case "auto":
        changed = c.setAuto(now, msg.auto);
        break;
      case "progression":
        changed = c.setProgression(msg.progression);
        break;
      case "feel":
        changed = c.setFeel(now, msg.feel);
        break;
    }
    if (changed) this.publish();
  }

  subscribe(l: Listener) {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }

  close() {
    this.closed = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    window.removeEventListener("pagehide", this.onLeave);
    this.onLeave();
  }

  // ---- network --------------------------------------------------------------

  private async pollLoop() {
    while (!this.closed) {
      const t0 = localNow();
      try {
        const res = await fetch(this.url, { cache: "no-store" });
        const t1 = localNow();
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
        this.clock.add(t0, body.ts, t1);
        this.error = null;
        this.connected = true;
        this.polls++;
        const room = body.room as PublishedRoom | null;
        if (room && (!this.remote || room.rev > this.remote.rev || room.rev < this.remote.rev - 60000)) {
          this.remote = room;
        }
        if (!this.conductor) this.state = this.viewOfRemote();
        this.emit();
      } catch (e) {
        this.connected = false;
        this.error = e instanceof Error && /storage/i.test(e.message) ? e.message : null;
        this.emit();
        await sleep(1000);
      }
      await sleep(this.nextPollDelay());
    }
  }

  private nextPollDelay() {
    if (this.polls < 8) return 60; // quick burst to sync clocks
    if (this.conductor) return 1000; // the guitar only needs clock samples
    // Poll fast whenever a guitar is here: a count-in can start the drums
    // within one beat, and the guitar books changes assuming POLL_MS.
    return this.players.some((p) => p.role === "guitar") ? POLL_MS : POLL_IDLE_MS;
  }

  /** The room as published by the guitar, plus who's here. */
  private viewOfRemote(): RoomState {
    const base = { ...initialState(), ...(this.remote?.state ?? {}) };
    const s = withPlayers(base, this.players);
    // Guitar phone gone (closed or asleep)? Stop the drums rather than play forever.
    if (s.transport.playing && !this.players.some((p) => p.role === "guitar")) {
      return { ...s, transport: { ...s.transport, playing: false }, status: "The guitar phone left" };
    }
    return s;
  }

  private async heartbeat() {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    if (this.closed) return;
    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "hello", id: this.you, role: this.role, rtt: Math.round(this.clock.rtt) }),
      });
      const body = await res.json();
      if (res.ok && Array.isArray(body.players)) {
        this.players = body.players;
        if (this.conductor) {
          this.conductor.state.players = this.players;
          this.state = { ...this.conductor.state };
        } else {
          this.state = this.viewOfRemote();
        }
        this.emit();
      }
    } catch {}
    this.heartbeatTimer = setTimeout(() => this.heartbeat(), HEARTBEAT_MS);
  }

  /** Upload the guitar's room. Coalesces bursts: at most one request in flight. */
  private async publish() {
    const c = this.conductor;
    if (!c) return;
    this.state = { ...c.state };
    this.emit();
    if (this.publishing) {
      this.dirty = true;
      return;
    }
    this.publishing = true;
    try {
      do {
        this.dirty = false;
        const room: PublishedRoom = { rev: Math.round(this.clock.now()), state: { ...c.state, players: [] } };
        this.remote = room;
        await fetch(this.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "state", room }),
        });
      } while (this.dirty && this.conductor);
    } catch {
      // Network hiccup: try again shortly.
      setTimeout(() => this.publish(), 500);
    } finally {
      this.publishing = false;
    }
  }

  private onLeave = () => {
    try {
      navigator.sendBeacon?.(
        this.url,
        new Blob([JSON.stringify({ type: "bye", id: this.you })], { type: "application/json" }),
      );
    } catch {}
  };

  private emit() {
    this.listeners.forEach((l) => l());
  }
}

function withPlayers(s: RoomState, players: Player[]): RoomState {
  return { ...s, players };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomId() {
  const b = crypto.getRandomValues(new Uint8Array(9));
  return Array.from(b, (x) => x.toString(36).padStart(2, "0")).join("");
}
