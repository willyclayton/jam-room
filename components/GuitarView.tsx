"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { RoomConnection } from "@/lib/client/connection";
import { CHORDS, type ChordName } from "@/lib/chords";
import { STYLES, STYLE_LABELS } from "@/lib/protocol";
import { type AudioModule, useBeat, useRoom } from "./Room";
import TempoStrip from "./TempoStrip";

/** Finger travel (px) that counts as a strum. */
const THRESHOLD = 18;

/** Swipe speed (px/ms) to strum strength 0..1. */
function strengthFromSpeed(speed: number) {
  return Math.max(0.08, Math.min(1, Math.sqrt(speed / 2.5)));
}

type Track = {
  id: number;
  start: number;
  anchorY: number;
  anchorT: number;
  lastDir: 0 | 1 | -1;
  fired: boolean;
};

export default function GuitarView({
  conn,
  audio,
  delayMs,
  topbar,
}: {
  conn: RoomConnection;
  audio: AudioModule;
  delayMs: number;
  topbar: React.ReactNode;
  onSwitch: () => void;
}) {
  const state = useRoom(conn);
  const beat = useBeat(conn, delayMs);
  const guitar = useMemo(() => new audio.Guitar(), [audio]);
  const [chord, setChord] = useState<ChordName>("G");
  const chordRef = useRef(chord);
  chordRef.current = chord;
  const track = useRef<Track | null>(null);
  const flashRef = useRef<HTMLDivElement>(null);
  const [lastDir, setLastDir] = useState<"down" | "up" | null>(null);

  const strum = (dir: "down" | "up", strength: number) => {
    const c = chordRef.current;
    guitar.strum(c, dir, strength);
    const at = audio.heardNow(conn.clock, delayMs);
    conn.send({ type: "strum", at, chord: c, dir, strength });
    audio.debugHook()?.onStrum?.(at);
    setLastDir(dir);
    const el = flashRef.current;
    if (el) {
      el.classList.remove("go");
      void el.offsetWidth; // restart the animation
      el.style.setProperty("--o", String(0.12 + strength * 0.35));
      el.classList.add("go");
    }
  };
  const strumRef = useRef(strum);
  strumRef.current = strum;

  // Laptop keys: 1–6 pick chords, space / ↓ strum down, ↑ strum up.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const n = Number(e.key);
      if (n >= 1 && n <= CHORDS.length) setChord(CHORDS[n - 1]);
      else if (e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        strumRef.current("down", 0.6);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        strumRef.current("up", 0.5);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    track.current = { id: e.pointerId, start: e.timeStamp, anchorY: e.clientY, anchorT: e.timeStamp, lastDir: 0, fired: false };
  };

  const onMove = (e: React.PointerEvent) => {
    const tr = track.current;
    if (!tr || tr.id !== e.pointerId) return;
    const dy = e.clientY - tr.anchorY;
    const dir: 1 | -1 = dy > 0 ? 1 : -1;
    if (dir === tr.lastDir) {
      // Still going the same way: follow the finger so a reversal is measured from the turn.
      tr.anchorY = e.clientY;
      tr.anchorT = e.timeStamp;
      return;
    }
    if (Math.abs(dy) >= THRESHOLD) {
      const speed = Math.abs(dy) / Math.max(4, e.timeStamp - tr.anchorT);
      strum(dir === 1 ? "down" : "up", strengthFromSpeed(speed));
      tr.lastDir = dir;
      tr.fired = true;
      tr.anchorY = e.clientY;
      tr.anchorT = e.timeStamp;
    }
  };

  const onUp = (e: React.PointerEvent) => {
    const tr = track.current;
    if (!tr || tr.id !== e.pointerId) return;
    // A quick tap without a swipe still strums.
    if (!tr.fired && e.timeStamp - tr.start < 350) strum("down", 0.45);
    track.current = null;
  };

  if (!state) return null;
  const t = state.transport;
  const playing = t.playing && t.endBeat === null;

  return (
    <main className="screen">
      {topbar}
      <TempoStrip state={state} beat={beat} synced={conn.clock.synced} connected={conn.connected} />

      <div className="styles" role="radiogroup" aria-label="Drum style">
        {STYLES.map((s) => (
          <button
            key={s}
            role="radio"
            aria-checked={state.style === s}
            className={`style ${state.style === s ? "on" : ""}`}
            onClick={() => conn.send({ type: "style", style: s })}
          >
            {STYLE_LABELS[s]}
          </button>
        ))}
      </div>

      <div className="chords">
        {CHORDS.map((c) => (
          <button
            key={c}
            className={`chord ${chord === c ? "on" : ""}`}
            onPointerDown={() => setChord(c)}
            onClick={() => setChord(c)}
          >
            {c}
          </button>
        ))}
      </div>

      <div
        className="strum"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        aria-label="Strum area: swipe down or up"
        data-testid="strum"
      >
        <div className="flash" ref={flashRef} />
        <div className="big">{chord}</div>
        <div className="small">
          {lastDir === null ? "Swipe down and up to strum" : lastDir === "down" ? "↓ down" : "↑ up"}
        </div>
      </div>

      <div className="controls">
        <button
          className="toggle"
          aria-pressed={state.follow}
          onClick={() => conn.send({ type: "follow", follow: !state.follow })}
        >
          <span className="switch" /> Follow me
        </button>
        <button className="btn small" onClick={() => conn.send({ type: "bpm", bpm: state.bpm / 2 })} aria-label="Half tempo">
          ½×
        </button>
        <button className="btn small" onClick={() => conn.send({ type: "bpm", bpm: state.bpm * 2 })} aria-label="Double tempo">
          2×
        </button>
        <div style={{ flex: 1 }} />
        {playing ? (
          <button className="btn small" onClick={() => conn.send({ type: "stop" })}>
            ■ End
          </button>
        ) : (
          <button className="btn small primary" onClick={() => conn.send({ type: "start" })}>
            ▶ Drums
          </button>
        )}
      </div>
      <BpmSlider bpm={state.bpm} onChange={(bpm) => conn.send({ type: "bpm", bpm })} follow={state.follow} />
    </main>
  );
}

function BpmSlider({ bpm, onChange, follow }: { bpm: number; onChange: (n: number) => void; follow: boolean }) {
  // Local value while dragging so remote updates don't fight the thumb.
  const [drag, setDrag] = useState<number | null>(null);
  return (
    <label className="slider">
      <span style={{ minWidth: 92 }}>{follow ? "Tempo (auto)" : "Tempo"}</span>
      <input
        type="range"
        min={60}
        max={180}
        step={1}
        value={Math.round(drag ?? bpm)}
        onChange={(e) => setDrag(Number(e.target.value))}
        onPointerUp={() => {
          if (drag !== null) onChange(drag);
          setDrag(null);
        }}
        onKeyUp={() => {
          if (drag !== null) onChange(drag);
          setDrag(null);
        }}
      />
    </label>
  );
}
