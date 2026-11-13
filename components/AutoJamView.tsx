"use client";

import { useEffect, useMemo, useState } from "react";
import type { RoomConnection } from "@/lib/client/connection";
import { CHORDS, type ChordName } from "@/lib/chords";
import { LOOP_BARS, PRESETS } from "@/lib/auto";
import { type Feel, STYLES, STYLE_LABELS } from "@/lib/protocol";
import { type AudioModule, useBeat, useRoom } from "./Room";
import TempoStrip from "./TempoStrip";

const FEELS: { feel: Feel; label: string }[] = [
  { feel: 0, label: "Chill" },
  { feel: 1, label: "Groove" },
  { feel: 2, label: "Hard" },
];

/**
 * Auto-jam: press Play and the guitar strums the chord loop by itself, in
 * time with the drums. Tap a bar, then a chord, to change the loop. If no
 * drum phone has joined, this phone plays the drums too.
 */
export default function AutoJamView({
  conn,
  audio,
  delayMs,
  topbar,
}: {
  conn: RoomConnection;
  audio: AudioModule;
  delayMs: number;
  topbar: React.ReactNode;
}) {
  const state = useRoom(conn);
  const beat = useBeat(conn, delayMs);
  const guitarSched = useMemo(() => new audio.GuitarScheduler(new audio.Guitar(), conn.clock), [audio, conn]);
  const drumSched = useMemo(() => new audio.DrumScheduler(new audio.DrumKit(), conn.clock), [audio, conn]);
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    guitarSched.start();
    drumSched.start();
    return () => {
      guitarSched.stop();
      drumSched.stop();
    };
  }, [guitarSched, drumSched]);

  const soloDrums = !!state && !state.players.some((p) => p.role === "drums");
  useEffect(() => {
    if (!state) return;
    guitarSched.room = state;
    guitarSched.delayMs = delayMs;
    // Nobody on drums? Play them here so one phone is a whole band.
    drumSched.transport = soloDrums ? state.transport : null;
    drumSched.delayMs = delayMs;
  }, [guitarSched, drumSched, state, delayMs, soloDrums]);

  if (!state) return null;
  const t = state.transport;
  const playing = t.playing && t.endBeat === null;
  const progression = state.progression as ChordName[];
  const nowSlot = playing && beat !== null && beat >= 0 ? Math.floor(beat / 4) % LOOP_BARS : -1;

  const setChord = (c: ChordName) => {
    const next = [...progression];
    next[selected] = c;
    conn.send({ type: "progression", progression: next });
    setSelected((selected + 1) % LOOP_BARS); // ready for the next bar
  };

  return (
    <main className="screen">
      {topbar}
      <TempoStrip state={state} beat={beat} synced={conn.clock.synced} connected={conn.connected} error={conn.error} />

      <button
        className={`btn play ${playing ? "" : "primary"}`}
        onClick={() => conn.send({ type: playing ? "stop" : "start" })}
        disabled={!conn.clock.synced}
      >
        {playing ? "■ Stop" : "▶ Play"}
      </button>

      <div className="loop" aria-label="Chord loop">
        {progression.map((c, i) => (
          <button
            key={i}
            className={`slot ${i === nowSlot ? "now" : ""} ${i === selected ? "sel" : ""}`}
            onClick={() => setSelected(i)}
            aria-label={`Bar ${i + 1}: ${c}${i === selected ? " (selected)" : ""}`}
          >
            <small>Bar {i + 1}</small>
            {c}
          </button>
        ))}
      </div>

      <div className="chords">
        {CHORDS.map((c) => (
          <button key={c} className={`chord ${progression[selected] === c ? "on" : ""}`} onClick={() => setChord(c)}>
            {c}
          </button>
        ))}
      </div>

      <div className="presets">
        {PRESETS.map((p) => (
          <button
            key={p.name}
            className="btn small"
            onClick={() => conn.send({ type: "progression", progression: p.chords })}
            title={p.chords.join(" ")}
          >
            {p.name}
          </button>
        ))}
      </div>

      <div className="styles" role="radiogroup" aria-label="Style">
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

      <div className="styles feels" role="radiogroup" aria-label="Feel">
        {FEELS.map(({ feel, label }) => (
          <button
            key={feel}
            role="radio"
            aria-checked={state.feel === feel}
            className={`style ${state.feel === feel ? "on" : ""}`}
            onClick={() => conn.send({ type: "feel", feel })}
          >
            {label}
          </button>
        ))}
      </div>

      <TempoSlider bpm={state.bpm} onChange={(bpm) => conn.send({ type: "bpm", bpm })} />

      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <span className="chip">{soloDrums ? "🥁 Drums on this phone" : "🥁 Drums on the other phone"}</span>
        <button className="btn small" onClick={() => conn.send({ type: "auto", auto: false })}>
          I’ll strum myself
        </button>
      </div>
    </main>
  );
}

function TempoSlider({ bpm, onChange }: { bpm: number; onChange: (n: number) => void }) {
  const [drag, setDrag] = useState<number | null>(null);
  const commit = () => {
    if (drag !== null) onChange(drag);
    setDrag(null);
  };
  return (
    <label className="slider">
      <span style={{ minWidth: 92 }}>Tempo {Math.round(drag ?? bpm)}</span>
      <input
        type="range"
        min={60}
        max={180}
        step={1}
        value={Math.round(drag ?? bpm)}
        onChange={(e) => setDrag(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onTouchEnd={commit}
      />
    </label>
  );
}
