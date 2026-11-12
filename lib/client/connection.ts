"use client";

import PartySocket from "partysocket";
import type { ClientMessage, Role, RoomState, ServerMessage } from "../protocol";

/** Wall-clock ms with sub-ms precision that never jumps backwards. */
export function localNow() {
  return performance.timeOrigin + performance.now();
}

type Sample = { rtt: number; offset: number };

/**
 * Estimates the offset between this phone's clock and the room server's
 * (NTP-style). Keeps the samples with the lowest round trip, which are the
 * most accurate.
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
    if (this.samples.length > 12) this.samples.shift();
    const best = [...this.samples].sort((a, b) => a.rtt - b.rtt).slice(0, 3);
    // Average the best few, weighting toward the fastest.
    this.offset = best.reduce((s, x) => s + x.offset, 0) / best.length;
    this.rtt = best[0].rtt;
    this.synced = this.samples.length >= 3;
  }

  /** Current time on the room server's clock. */
  now() {
    return localNow() + this.offset;
  }
}

export function partyHost() {
  const env = process.env.NEXT_PUBLIC_PARTYKIT_HOST;
  if (env) return env;
  // Local dev: the PartyKit dev server on the same machine as the page, so
  // phones on the same Wi-Fi can reach it too.
  if (typeof window !== "undefined") return `${window.location.hostname}:1999`;
  return "localhost:1999";
}

type Listener = () => void;
type StrumListener = (msg: Extract<ServerMessage, { type: "strum" }>) => void;

export class RoomConnection {
  socket: PartySocket;
  clock = new ClockSync();
  state: RoomState | null = null;
  you = "";
  connected = false;
  private listeners = new Set<Listener>();
  private strumListeners = new Set<StrumListener>();
  private pingId = 0;
  private pending = new Map<number, number>();
  private pingTimer: ReturnType<typeof setTimeout> | null = null;
  private role: Role = "listener";

  constructor(readonly roomId: string) {
    this.socket = new PartySocket({ host: partyHost(), room: roomId });
    this.socket.addEventListener("open", () => {
      this.connected = true;
      this.send({ type: "hello", name: "", role: this.role });
      this.burst();
      this.emit();
    });
    this.socket.addEventListener("close", () => {
      this.connected = false;
      this.emit();
    });
    this.socket.addEventListener("message", (e: MessageEvent) => this.onMessage(e.data));
  }

  private onMessage(data: unknown) {
    if (typeof data !== "string") return;
    const t1 = localNow();
    const msg = JSON.parse(data) as ServerMessage;
    if (msg.type === "pong") {
      const t0 = this.pending.get(msg.id);
      if (t0 !== undefined) {
        this.pending.delete(msg.id);
        this.clock.add(t0, msg.ts, t1);
        if (this.clock.synced) this.emit();
      }
    } else if (msg.type === "state") {
      this.state = msg.state;
      this.you = msg.you;
      this.emit();
    } else if (msg.type === "strum") {
      this.strumListeners.forEach((l) => l(msg));
    }
  }

  /** Quick run of pings on connect, then a steady trickle to track drift. */
  private burst() {
    if (this.pingTimer) clearTimeout(this.pingTimer);
    let n = 0;
    const tick = () => {
      this.ping();
      n++;
      this.pingTimer = setTimeout(tick, n < 8 ? 120 : 3000);
    };
    tick();
  }

  private ping() {
    if (!this.connected) return;
    const id = ++this.pingId;
    const t0 = localNow();
    this.pending.set(id, t0);
    if (this.pending.size > 20) this.pending.delete(this.pending.keys().next().value!);
    this.send({ type: "ping", id, t0, rtt: Math.round(this.clock.rtt) });
  }

  send(msg: ClientMessage) {
    if (msg.type === "hello" || msg.type === "role") this.role = msg.role;
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(msg));
  }

  setRole(role: Role) {
    this.send({ type: "role", role });
  }

  subscribe(l: Listener) {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }

  onStrum(l: StrumListener) {
    this.strumListeners.add(l);
    return () => {
      this.strumListeners.delete(l);
    };
  }

  private emit() {
    this.listeners.forEach((l) => l());
  }

  close() {
    if (this.pingTimer) clearTimeout(this.pingTimer);
    this.socket.close();
  }
}
