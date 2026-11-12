// Messages and shared state passed between phones and the room server.
// All times are "shared time": milliseconds on the room server's clock.

export type Role = "guitar" | "drums" | "listener";
export type Style = "rock" | "funk" | "bossa" | "lofi";
export const STYLES: Style[] = ["rock", "funk", "bossa", "lofi"];
export const STYLE_LABELS: Record<Style, string> = {
  rock: "Rock",
  funk: "Funk",
  bossa: "Bossa",
  lofi: "Lo-fi",
};

/** 0 = soft (half-time / rim), 1 = normal, 2 = hard (busier hats, more kicks) */
export type Feel = 0 | 1 | 2;

/**
 * A stretch of the beat grid. From `time` onwards, beat `beat` is at `time`
 * and beats advance at `bpm`. Style and feel also change here.
 * Segments always start on a bar line (beat % 4 === 0).
 */
export type Segment = {
  beat: number;
  time: number;
  bpm: number;
  style: Style;
  feel: Feel;
};

/** A one-off drum event on the grid. */
export type Mark =
  /** Play a fill from `beat` up to the next bar line, then crash. */
  | { kind: "fill"; beat: number }
  /** Crash on `beat`. */
  | { kind: "crash"; beat: number };

export type Transport = {
  /** Bumped every time the drummer starts from silence. */
  epoch: number;
  playing: boolean;
  segments: Segment[];
  marks: Mark[];
  /** Beat of the final crash. Nothing plays after it. */
  endBeat: number | null;
};

export type Player = {
  id: string;
  name: string;
  role: Role;
  rtt: number;
};

export type RoomState = {
  players: Player[];
  style: Style;
  /** Tempo used when the drummer starts by button, and the current target tempo. */
  bpm: number;
  /** When true, the drummer follows strum timing. When false, BPM is manual. */
  follow: boolean;
  chord: string | null;
  feel: Feel;
  transport: Transport;
  /** Shown on screens, e.g. "Strum 4 times to count in". */
  status: string;
};

export type ClientMessage =
  | { type: "hello"; name: string; role: Role }
  | { type: "role"; role: Role }
  | { type: "ping"; id: number; t0: number; rtt: number }
  | {
      type: "strum";
      /** Shared time the strum is heard on the guitar phone. */
      at: number;
      chord: string;
      dir: "down" | "up";
      /** 0..1, from swipe speed */
      strength: number;
    }
  | { type: "style"; style: Style }
  | { type: "bpm"; bpm: number }
  | { type: "follow"; follow: boolean }
  | { type: "start" }
  | { type: "stop" };

export type ServerMessage =
  | { type: "state"; state: RoomState; you: string }
  | { type: "pong"; id: number; t0: number; ts: number }
  | {
      type: "strum";
      at: number;
      chord: string;
      dir: "down" | "up";
      strength: number;
      from: string;
    };
