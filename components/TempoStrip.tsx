import type { RoomState } from "@/lib/protocol";

export function BeatDots({ beat, count = 4 }: { beat: number | null; count?: number }) {
  const pos = beat === null ? -1 : ((beat % count) + count) % count;
  return (
    <div className="beats" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className={`beat ${pos === i ? "on" : ""} ${i === 0 ? "one" : ""}`} />
      ))}
    </div>
  );
}

export default function TempoStrip({
  state,
  beat,
  synced,
  connected,
  error,
}: {
  state: RoomState;
  beat: number | null;
  synced: boolean;
  connected: boolean;
  error?: string | null;
}) {
  let status = state.status;
  if (error) status = error;
  else if (!connected) status = "Connecting…";
  else if (!synced) status = "Syncing clocks…";
  else if (!state.players.some((p) => p.role === "drums")) status = state.transport.playing ? status : "Waiting for a drum phone";
  return (
    <>
      {!connected && <div className="offline">Can’t reach the room. Retrying…</div>}
      <div className="tempo">
        <div className="bpm">
          {Math.round(state.bpm)}
          <small>BPM</small>
        </div>
        <BeatDots beat={beat} />
        <div className="status" data-testid="status">
          {status}
        </div>
      </div>
    </>
  );
}
