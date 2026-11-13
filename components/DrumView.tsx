"use client";

import { useEffect, useMemo } from "react";
import type { RoomConnection } from "@/lib/client/connection";
import { STYLE_LABELS } from "@/lib/protocol";
import { type AudioModule, useBeat, useRoom } from "./Room";
import { BeatDots } from "./TempoStrip";

const FEEL_LABELS = ["Soft · half-time", "Groove", "Hard · busy"];

export default function DrumView({
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
  const scheduler = useMemo(() => new audio.DrumScheduler(new audio.DrumKit(), conn.clock), [audio, conn]);

  useEffect(() => {
    scheduler.start();
    return () => scheduler.stop();
  }, [scheduler]);

  useEffect(() => {
    scheduler.transport = state?.transport ?? null;
    scheduler.delayMs = delayMs;
  }, [scheduler, state, delayMs]);

  if (!state) return null;
  const t = state.transport;
  const seg = t.segments.length ? t.segments[t.segments.length - 1] : null;
  let status = state.status;
  if (conn.error) status = conn.error;
  else if (!conn.connected) status = "Connecting…";
  else if (!conn.clock.synced) status = "Syncing clocks…";
  else if (!t.playing && !state.players.some((p) => p.role === "guitar")) status = "Waiting for a guitar phone";
  else if (!t.playing) status = state.follow ? "Waiting for the guitar to count in" : "Waiting for Start";

  return (
    <main className="screen">
      {topbar}
      {!conn.connected && <div className="offline">Can’t reach the room. Retrying…</div>}
      <div className="stage">
        <div className="now-chord" aria-label="Current chord">
          {state.chord ?? "–"}
        </div>
        <BeatDots beat={beat} />
        <div className="bpm">
          {Math.round(seg?.bpm ?? state.bpm)}
          <small>BPM</small>
        </div>
        <div className="tags">
          <span className="tag">{STYLE_LABELS[seg?.style ?? state.style]}</span>
          <span className="tag">{FEEL_LABELS[seg?.feel ?? state.feel]}</span>
          {beat !== null && <span className="tag">Bar {Math.floor(beat / 4) + 1}</span>}
        </div>
        <p className="lede" data-testid="status">
          {status}
        </p>
      </div>
      <div className="hint">
        <span aria-hidden>🔊</span>
        <span>Keep this screen on and the volume up. Put this phone where the guitarist can hear it.</span>
      </div>
    </main>
  );
}
