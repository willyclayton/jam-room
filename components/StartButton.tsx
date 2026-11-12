"use client";

import { useRouter } from "next/navigation";

/** Short room codes that are easy to read out loud (no 0/O, 1/I/L). */
function roomCode() {
  const abc = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return Array.from(bytes, (b) => abc[b % abc.length]).join("");
}

export default function StartButton() {
  const router = useRouter();
  return (
    <button className="btn primary" onClick={() => router.push(`/room/${roomCode()}`)}>
      Start a jam
    </button>
  );
}
