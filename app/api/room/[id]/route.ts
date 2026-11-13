// The room API. Phones talk to it over plain HTTP:
//
//   GET  /api/room/:id          → { ts, room }   poll for the latest room (and a clock sample)
//   POST /api/room/:id  state   → { ts }         the guitar phone publishes the room
//   POST /api/room/:id  hello   → { ts, players } presence heartbeat (role + network quality)
//
// `ts` is this server's clock. Phones use it to agree on one shared time.

import { NextResponse } from "next/server";
import { getStore, StoreMissingError } from "@/lib/server/store";
import type { Player, Role } from "@/lib/protocol";

export const dynamic = "force-dynamic";

/** A phone that hasn't checked in for this long has left. */
const PLAYER_TIMEOUT_MS = 15000;

function roomKey(id: string) {
  return `jam:${id.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12)}`;
}

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function fail(e: unknown) {
  if (e instanceof StoreMissingError) return json({ error: e.message, code: "no-store" }, 503);
  console.error(e);
  return json({ error: "Room server error" }, 500);
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const raw = await getStore().get(`${roomKey(id)}:room`);
    return json({ ts: Date.now(), room: raw ? JSON.parse(raw) : null });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const key = roomKey(id);
    const body = (await req.json()) as Record<string, unknown>;
    const store = getStore();

    if (body.type === "state") {
      const room = body.room;
      if (!room || typeof room !== "object") return json({ error: "bad room" }, 400);
      const text = JSON.stringify(room);
      if (text.length > 64_000) return json({ error: "room too big" }, 413);
      await store.set(`${key}:room`, text);
      return json({ ts: Date.now() });
    }

    if (body.type === "hello" || body.type === "bye") {
      const pid = String(body.id ?? "").slice(0, 40);
      if (!pid) return json({ error: "missing id" }, 400);
      if (body.type === "bye") {
        await store.hdel(`${key}:players`, pid);
        return json({ ts: Date.now() });
      }
      const role: Role = body.role === "guitar" || body.role === "drums" ? body.role : "listener";
      const rtt = Math.max(0, Math.min(5000, Number(body.rtt) || 0));
      const now = Date.now();
      const all = await store.hsetAll(`${key}:players`, pid, JSON.stringify({ role, rtt, seen: now }));
      const players: Player[] = [];
      for (const [pidKey, v] of Object.entries(all)) {
        try {
          const p = JSON.parse(v) as { role: Role; rtt: number; seen: number };
          if (now - p.seen < PLAYER_TIMEOUT_MS) players.push({ id: pidKey, name: "", role: p.role, rtt: p.rtt });
        } catch {}
      }
      return json({ ts: Date.now(), players });
    }

    return json({ error: "unknown message" }, 400);
  } catch (e) {
    return fail(e);
  }
}
