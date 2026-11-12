import type * as Party from "partykit/server";
import { Conductor } from "../lib/conductor";
import type { ClientMessage, Player, Role, ServerMessage } from "../lib/protocol";
import { STYLES } from "../lib/protocol";

type ConnState = { name: string; role: Role; rtt: number };

/**
 * One jam room. Keeps the shared clock, the list of players and the drummer
 * brain (Conductor). Every phone gets the full state on each change; the
 * state is small.
 */
export default class JamRoom implements Party.Server {
  conductor = new Conductor();
  timer: ReturnType<typeof setInterval> | null = null;

  constructor(readonly room: Party.Room) {}

  onConnect(conn: Party.Connection<ConnState>) {
    conn.setState({ name: "", role: "listener", rtt: 0 });
    this.syncPlayers();
    this.send(conn, { type: "state", state: this.conductor.state, you: conn.id });
    this.broadcastState();
  }

  onClose() {
    this.syncPlayers();
    this.broadcastState();
    if (![...this.room.getConnections()].length) this.stopTimer();
  }

  onError() {
    this.onClose();
  }

  onMessage(raw: string | ArrayBuffer | ArrayBufferView, sender: Party.Connection<ConnState>) {
    if (typeof raw !== "string") return;
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const now = Date.now();
    const c = this.conductor;
    let changed = false;

    switch (msg.type) {
      case "ping": {
        // Answer first so the clock sample is as tight as possible.
        this.send(sender, { type: "pong", id: msg.id, t0: msg.t0, ts: Date.now() });
        const rtt = Number(msg.rtt) || 0;
        const prev = sender.state?.rtt ?? 0;
        sender.setState({ ...(sender.state as ConnState), rtt });
        // Only rebroadcast when the connection quality meaningfully changed.
        if (Math.abs(rtt - prev) > 40) {
          this.syncPlayers();
          changed = true;
        }
        break;
      }
      case "hello":
        sender.setState({
          name: String(msg.name ?? "").slice(0, 24),
          role: validRole(msg.role),
          rtt: sender.state?.rtt ?? 0,
        });
        this.syncPlayers();
        changed = true;
        break;
      case "role":
        sender.setState({ ...(sender.state as ConnState), role: validRole(msg.role) });
        this.syncPlayers();
        changed = true;
        break;
      case "strum": {
        const strength = Math.max(0, Math.min(1, Number(msg.strength) || 0));
        const at = Number(msg.at) || now;
        const chord = String(msg.chord ?? "").slice(0, 8);
        // Tell everyone right away (drum phones show the chord; later a bass phone plays it).
        const out: ServerMessage = { type: "strum", at, chord, dir: msg.dir === "up" ? "up" : "down", strength, from: sender.id };
        this.room.broadcast(JSON.stringify(out), [sender.id]);
        changed = c.strum(now, at, chord, strength);
        break;
      }
      case "style":
        if (STYLES.includes(msg.style)) changed = c.setStyle(now, msg.style);
        break;
      case "bpm":
        if (Number.isFinite(msg.bpm)) changed = c.setBpm(now, msg.bpm);
        break;
      case "follow":
        changed = c.setFollow(!!msg.follow);
        break;
      case "start":
        changed = c.start(now);
        break;
      case "stop":
        changed = c.stop(now);
        break;
    }

    if (changed) this.broadcastState();
    if (c.state.transport.playing) this.startTimer();
  }

  // ---- helpers ------------------------------------------------------------

  private syncPlayers() {
    const players: Player[] = [];
    for (const conn of this.room.getConnections<ConnState>()) {
      const s = conn.state;
      players.push({ id: conn.id, name: s?.name ?? "", role: s?.role ?? "listener", rtt: s?.rtt ?? 0 });
    }
    this.conductor.state.players = players;
  }

  private startTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const c = this.conductor;
      if (c.tick(Date.now())) this.broadcastState();
      if (!c.state.transport.playing) this.stopTimer();
    }, 100);
  }

  private stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private broadcastState() {
    for (const conn of this.room.getConnections()) {
      this.send(conn, { type: "state", state: this.conductor.state, you: conn.id });
    }
  }

  private send(conn: Party.Connection, msg: ServerMessage) {
    conn.send(JSON.stringify(msg));
  }
}

function validRole(r: unknown): Role {
  return r === "guitar" || r === "drums" ? r : "listener";
}
