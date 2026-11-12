"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";

export default function ShareSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const [url, setUrl] = useState("");
  const [qr, setQr] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const u = `${window.location.origin}/room/${id}`;
    setUrl(u);
    QRCode.toDataURL(u, { margin: 1, width: 400, color: { dark: "#0f0e13", light: "#ffffff" } }).then(setQr);
  }, [id]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  const share = async () => {
    try {
      await navigator.share({ title: "Jam Room", text: "Join my jam", url });
    } catch {}
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Invite">
        <h2>Scan to join room {id}</h2>
        {qr ? <img className="qr" src={qr} alt={`QR code for ${url}`} /> : <div className="qr" />}
        <div className="link">{url}</div>
        <div className="row">
          <button className="btn small primary" onClick={copy}>
            {copied ? "Copied" : "Copy link"}
          </button>
          {typeof navigator !== "undefined" && "share" in navigator && (
            <button className="btn small" onClick={share}>
              Share…
            </button>
          )}
          <button className="btn small" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
