# Jam Room

Phones join a room by link. One phone is the guitar, another is the drummer, and the drummer follows your tempo and feel in real time.

## Run it locally

```bash
npm install
npm run dev        # http://localhost:3000. Rooms live in memory, no setup needed.
```

To use real phones, open `http://<your-computer's-LAN-IP>:3000` on phones on the same Wi-Fi.

On a laptop you can play the guitar with the keyboard: keys **1–6** pick chords, **Space / ↓** strums down, **↑** strums up.

## Deploy (all on Vercel, $0)

1. Push to `main`. Vercel builds it.
2. In the Vercel project: **Storage → Create → Upstash for Redis** (free plan), and connect it to this project. This sets `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (or the `KV_REST_API_*` names, which work too).
3. Redeploy. Until storage is connected, the app shows a message saying so.

## How it plays

- **Count-in:** strum 4 steady beats. The drums come in on the next bar, with beat 1 on your first strum. You can also press **▶ Drums** to start at the slider tempo.
- **Following:** the drummer fits a line through your recent strums. Small drifts are nudged on the next beat. A clear tempo jump (4 steady strums more than 10% off) resyncs like a fresh count-in. Quarters, 8ths, mixed patterns like D‑DU‑UDU, and half notes all work.
- **Feel:** swipe speed sets strum strength. Hard strumming gives busier hats and more kicks. Soft strumming gives half-time with rim clicks.
- **Fills:** at the end of every 8 bars (every 4 when playing hard), and when you change chord after holding one for 2+ bars.
- **Stop:** stop strumming for about 2 bars. The drummer plays a fill, crashes on the bar line, and ends. **■ End** does the same on demand.
- **Styles:** Rock, Funk, Bossa, Lo-fi (picked on the guitar phone; changes land on the next bar).
- **Backups:** turn off *Follow me* to set the tempo by slider. **½× / 2×** fix a double-time or half-time read.
- **Bluetooth speakers:** ⚙︎ → *Speaker delay* shifts that phone earlier to make up for the speaker lag.

## How sync works

- Everything runs on Vercel. Vercel can't hold live connections, so phones talk to one small API route over plain HTTP, and the room is kept in Upstash Redis.
- **The guitar phone is the room's brain.** It runs the drummer logic (`Conductor`) locally, so strums never leave the phone. It uploads the room only when it changes (about once a beat while following).
- **Other phones poll** every 200 ms while a guitar is in the room. Every poll is also a clock sample (NTP-style, keeping the fastest round trips), so all phones share the server's clock.
- The room holds the beat grid as **segments** (`beat N is at time T, then BPM B`). Phones never get "play now". Each drum phone books 16th notes ~150 ms ahead on its audio clock from that grid, using the output timestamp so sounds leave the speaker at the shared time.
- Changes are booked at least 1 beat ahead (2 on slow connections), and never closer than 250 ms + the polling interval + the worst round trip. Style and feel change on bar lines.
- Drum patterns are deterministic (seeded per bar), so several drum phones play exactly the same thing.
- The guitar timestamps each strum with when it's *heard* (now + output latency), so the drummer lines up with the sound and not with the touch.
- If the guitar phone leaves (closed or asleep for ~15 s), the drum phones stop.

## Code map

| Path | What |
| --- | --- |
| `lib/conductor.ts` | Drummer brain: count-in, tempo/phase following, resync, fills, endings. Pure logic. |
| `lib/tempo.ts` | Count-in detection and the strum-to-grid line fit |
| `lib/patterns.ts` | Drum patterns per style × feel, fills, endings |
| `lib/transport.ts` | Beat ↔ time on the segment grid |
| `app/api/room/[id]/route.ts` | Room API: poll the room (plus server time), publish it, presence heartbeat |
| `lib/server/store.ts` | Upstash Redis in production, memory in local dev |
| `lib/client/` | Clock sync, polling, and the guitar-hosted conductor (`connection.ts`); Tone.js guitar, drum kit and scheduler (`audio.ts`) |
| `components/` | Role picker, guitar and drum screens, share (QR) and settings sheets |
| `test/conductor.test.ts` | Simulated guitarists: steady, drifting, jumping, sloppy, many strum patterns |

Sounds are synthesised with Tone.js (plucked strings, synth drums), so there's nothing to download or license. Sampled instruments can be swapped in later behind the same `Guitar` and `DrumKit` classes.

## Tests

```bash
npm test           # simulated jams, including polling delays: timing must stay tight
npm run typecheck
```

## Not built yet

Phase 4 (bass, keys, human drum pads) and Phase 5 (recording/MP3, Web MIDI input, producer mode) from the plan.
