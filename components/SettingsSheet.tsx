"use client";

export default function SettingsSheet({
  delayMs,
  onDelay,
  onSwitch,
  onClose,
}: {
  delayMs: number;
  onDelay: (ms: number) => void;
  onSwitch: () => void;
  onClose: () => void;
}) {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Settings">
        <h2>Settings</h2>
        <label className="slider">
          <span style={{ minWidth: 120, textAlign: "left" }}>Speaker delay</span>
          <input type="range" min={0} max={400} step={10} value={delayMs} onChange={(e) => onDelay(Number(e.target.value))} />
          <span style={{ minWidth: 56, textAlign: "right" }}>{delayMs} ms</span>
        </label>
        <p className="lede" style={{ fontSize: 14 }}>
          Using a Bluetooth speaker? They lag. Raise this until this phone lines up with the others. On the phone speaker, leave it at 0.
        </p>
        <div className="row">
          <button className="btn small" onClick={onSwitch}>
            Switch instrument
          </button>
          <button className="btn small primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
