"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { RoomConnection } from "@/lib/client/connection";
import type { Role } from "@/lib/protocol";
import { beatAtTime } from "@/lib/transport";
import GuitarView from "./GuitarView";
import DrumView from "./DrumView";
import ShareSheet from "./ShareSheet";
import SettingsSheet from "./SettingsSheet";

export type AudioModule = typeof import("@/lib/client/audio");

const DELAY_KEY = "jamroom.delayMs";

function loadDelay() {
  try {
    return Number(localStorage.getItem(DELAY_KEY)) || 0;
  } catch {
    return 0;
  }
}

export default function Room({ id }: { id: string }) {
  const [conn, setConn] = useState<RoomConnection | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [audio, setAudio] = useState<AudioModule | null>(null);
  const [sheet, setSheet] = useState<"share" | "settings" | null>(null);
  const [delayMs, setDelayMs] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const c = new RoomConnection(id);
    setConn(c);
    setDelayMs(loadDelay());
    return () => c.close();
  }, [id]);

  // Keep the screen awake while playing (timers stall when a phone sleeps).
  useEffect(() => {
    if (!role) return;
    let lock: WakeLockSentinel | null = null;
    const request = async () => {
      try {
        lock = (await navigator.wakeLock?.request("screen")) ?? null;
      } catch {}
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") request();
    };
    request();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      lock?.release().catch(() => {});
    };
  }, [role]);

  const snapshot = useSyncExternalStore(
    useCallback((cb) => (conn ? conn.subscribe(cb) : () => {}), [conn]),
    () => (conn ? `${conn.connected}|${conn.clock.synced}|${JSON.stringify(conn.state)}` : ""),
    () => "",
  );
  void snapshot;
  const state = conn?.state ?? null;

  const pick = async (r: Role) => {
    if (!conn || busy) return;
    setBusy(true);
    try {
      // Must happen inside the tap for iPhone to allow sound.
      const mod = audio ?? (await import("@/lib/client/audio"));
      await mod.unlockAudio();
      setAudio(mod);
      conn.setRole(r);
      setRole(r);
    } finally {
      setBusy(false);
    }
  };

  const changeDelay = (ms: number) => {
    setDelayMs(ms);
    try {
      localStorage.setItem(DELAY_KEY, String(ms));
    } catch {}
  };

  const counts = { guitar: 0, drums: 0 };
  state?.players.forEach((p) => {
    if (p.role === "guitar" || p.role === "drums") counts[p.role]++;
  });

  const topbar = (
    <div className="topbar">
      <button className="room-code" onClick={() => setSheet("share")} aria-label="Share room link">
        {id} ↗
      </button>
      <div className="players">
        {counts.guitar > 0 && (
          <span className="chip">
            <span className="dot" style={{ background: "var(--guitar)" }} />
            Guitar{counts.guitar > 1 ? ` ×${counts.guitar}` : ""}
          </span>
        )}
        {counts.drums > 0 && (
          <span className="chip">
            <span className="dot" style={{ background: "var(--drums)" }} />
            Drums{counts.drums > 1 ? ` ×${counts.drums}` : ""}
          </span>
        )}
      </div>
      {role && (
        <button className="btn small" onClick={() => setSheet("settings")} aria-label="Settings">
          ⚙︎
        </button>
      )}
    </div>
  );

  let body: React.ReactNode;
  if (!role || !audio || !conn) {
    body = (
      <main className="screen center">
        {topbar}
        <div style={{ flex: 1 }} />
        <h1 className="title">Pick your instrument</h1>
        <p className="lede">Tapping one also switches on sound.</p>
        <div className="roles">
          <button
            className={`role guitar ${counts.guitar ? "taken" : ""}`}
            onClick={() => pick("guitar")}
            disabled={!conn || busy}
          >
            <span className="emoji">🎸</span>
            Guitar
            <small>{counts.guitar ? "Someone’s on it" : "Chords + strum"}</small>
          </button>
          <button
            className={`role drums ${counts.drums ? "taken" : ""}`}
            onClick={() => pick("drums")}
            disabled={!conn || busy}
          >
            <span className="emoji">🥁</span>
            Drums
            <small>{counts.drums ? "Someone’s on it" : "Follows the guitar"}</small>
          </button>
        </div>
        <div className="hint">
          <span aria-hidden>🔔</span>
          <span>
            <strong>On iPhone:</strong> turn the volume up. If you hear nothing, flip the silent switch off. Use the
            phone speaker, or set a Bluetooth delay in ⚙︎ later.
          </span>
        </div>
        <button className="btn" onClick={() => setSheet("share")}>
          Invite a phone: link or QR
        </button>
        <div style={{ flex: 1 }} />
      </main>
    );
  } else if (role === "guitar") {
    body = (
      <GuitarView conn={conn} audio={audio} delayMs={delayMs} topbar={topbar} onSwitch={() => setRole(null)} />
    );
  } else {
    body = <DrumView conn={conn} audio={audio} delayMs={delayMs} topbar={topbar} onSwitch={() => setRole(null)} />;
  }

  return (
    <>
      {body}
      {sheet === "share" && <ShareSheet id={id} onClose={() => setSheet(null)} />}
      {sheet === "settings" && (
        <SettingsSheet
          delayMs={delayMs}
          onDelay={changeDelay}
          onSwitch={() => {
            setSheet(null);
            conn?.setRole("listener");
            setRole(null);
          }}
          onClose={() => setSheet(null)}
        />
      )}
    </>
  );
}

/** Re-render on every room update (state, connection, clock sync). */
export function useRoom(conn: RoomConnection) {
  return useSyncExternalStore(
    useCallback((cb) => conn.subscribe(cb), [conn]),
    () => conn.state,
    () => null,
  );
}

/** The current beat (fractional) on the shared grid, updated every frame. */
export function useBeat(conn: RoomConnection, delayMs: number) {
  const [beat, setBeat] = useState<number | null>(null);
  const raf = useRef(0);
  useEffect(() => {
    let last: number | null = null;
    const loop = () => {
      const t = conn.state?.transport;
      let b: number | null = null;
      if (t && t.playing && t.segments.length) {
        const now = conn.clock.now() - delayMs;
        if (now >= t.segments[0].time && (t.endBeat === null || beatAtTime(t.segments, now) < t.endBeat + 1)) {
          b = beatAtTime(t.segments, now);
        }
      }
      const shown = b === null ? null : Math.floor(b);
      if (shown !== last) {
        last = shown;
        setBeat(shown);
      }
      raf.current = requestAnimationFrame(loop);
    };
    raf.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf.current);
  }, [conn, delayMs]);
  return beat;
}
