# Jam Room

Phones join a room by link. One phone is the guitar, another is the drummer, and the drummer follows your tempo and feel in real time.

## Run it locally

```bash
npm install
npm run dev        # Next.js on :3000 and the PartyKit room server on :1999
```

Open http://localhost:3000 and start a jam. To use real phones, open `http://<your-computer's-LAN-IP>:3000` on phones on the same Wi-Fi. In dev the app finds the room server on the same host at port 1999.

On a laptop you can play the guitar with the keyboard: keys **1–6** pick chords, **Space / ↓** strums down, **↑** strums up.

## Deploy ($0)

1. **Room server:** run `npx partykit deploy` (or `npm run deploy:party`). It prints a host like `jam-room.<you>.partykit.dev`.
2. **App:** import the repo into Vercel and set `NEXT_PUBLIC_PARTYKIT_HOST` to that host.

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

- Each phone measures its clock against the room server (ping/pong, keeping the fastest round trips), so all phones share one clock.
- The server holds the beat grid as **segments** (`beat N is at time T, then BPM B`). Phones never get "play now". Every drum phone books 16th notes ~150 ms ahead on its audio clock from that grid. The output timestamp is used so sounds leave the speaker at the shared time.
- Changes are booked at least 1 beat ahead (2 on slow connections). A booked change locks 250 ms + the worst round trip before it plays. Style and feel change on bar lines.
- Drum patterns are deterministic (seeded per bar), so several drum phones play exactly the same thing.
- The guitar timestamps each strum with when it's *heard* (now + output latency), so the drummer lines up with the sound and not with the touch.

## Code map

| Path | What |
| --- | --- |
| `lib/conductor.ts` | Drummer brain: count-in, tempo/phase following, resync, fills, endings. Pure logic. |
| `lib/tempo.ts` | Count-in detection and the strum-to-grid line fit |
| `lib/patterns.ts` | Drum patterns per style × feel, fills, endings |
| `lib/transport.ts` | Beat ↔ time on the segment grid |
| `party/server.ts` | PartyKit room: clock pings, players, relays strums, runs the conductor |
| `lib/client/` | Clock sync and socket (`connection.ts`); Tone.js guitar, drum kit and scheduler (`audio.ts`) |
| `components/` | Role picker, guitar and drum screens, share (QR) and settings sheets |
| `test/conductor.test.ts` | Simulated guitarists: steady, drifting, jumping, sloppy, many strum patterns |

Sounds are synthesised with Tone.js (plucked strings, synth drums), so there's nothing to download or license. Sampled instruments can be swapped in later behind the same `Guitar` and `DrumKit` classes.

## Tests

```bash
npm test           # simulated jams: timing must stay within a few ms
npm run typecheck
```

## Not built yet

Phase 4 (bass, keys, human drum pads) and Phase 5 (recording/MP3, Web MIDI input, producer mode) from the plan.
