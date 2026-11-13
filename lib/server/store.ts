// Room storage for the Vercel API. Uses Upstash Redis (add it to the Vercel
// project from the Marketplace: it sets the env vars below). In local dev,
// with no Redis configured, an in-memory store is used instead.

import { Redis } from "@upstash/redis";

const TTL_S = 6 * 60 * 60; // rooms vanish 6 hours after their last activity

export interface Store {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  /** Set one field of a hash and return the whole hash. */
  hsetAll(key: string, field: string, value: string): Promise<Record<string, string>>;
  hdel(key: string, field: string): Promise<void>;
}

class RedisStore implements Store {
  constructor(private r: Redis) {}
  async get(key: string) {
    const v = await this.r.get<string>(key);
    return v === null || v === undefined ? null : typeof v === "string" ? v : JSON.stringify(v);
  }
  async set(key: string, value: string) {
    await this.r.set(key, value, { ex: TTL_S });
  }
  async hsetAll(key: string, field: string, value: string) {
    const p = this.r.pipeline();
    p.hset(key, { [field]: value });
    p.expire(key, TTL_S);
    p.hgetall(key);
    const [, , all] = await p.exec<[number, number, Record<string, unknown> | null]>();
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(all ?? {})) out[k] = typeof v === "string" ? v : JSON.stringify(v);
    return out;
  }
  async hdel(key: string, field: string) {
    await this.r.hdel(key, field);
  }
}

class MemoryStore implements Store {
  private kv = new Map<string, string>();
  private h = new Map<string, Map<string, string>>();
  async get(key: string) {
    return this.kv.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.kv.set(key, value);
  }
  async hsetAll(key: string, field: string, value: string) {
    const m = this.h.get(key) ?? new Map();
    m.set(field, value);
    this.h.set(key, m);
    return Object.fromEntries(m);
  }
  async hdel(key: string, field: string) {
    this.h.get(key)?.delete(field);
  }
}

const g = globalThis as { __jamStore?: Store };

export class StoreMissingError extends Error {}

export function getStore(): Store {
  if (g.__jamStore) return g.__jamStore;
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (url && token) {
    g.__jamStore = new RedisStore(new Redis({ url, token }));
  } else if (process.env.NODE_ENV !== "production") {
    g.__jamStore = new MemoryStore();
  } else {
    // In production several server instances share no memory, so rooms
    // can't work without Redis. Say so clearly instead of half-working.
    throw new StoreMissingError(
      "Room storage isn't set up. In Vercel: Storage → Upstash for Redis → connect it to this project, then redeploy.",
    );
  }
  return g.__jamStore;
}
