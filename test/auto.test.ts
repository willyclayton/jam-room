import { describe, expect, it } from "vitest";
import { chordForBar, isProgression, PRESETS, strumPattern } from "../lib/auto";
import { Conductor, initialState } from "../lib/conductor";
import { STYLES } from "../lib/protocol";

describe("auto jam", () => {
  it("loops the progression one chord per bar", () => {
    const p = PRESETS[0].chords;
    expect([0, 1, 2, 3, 4, 7].map((b) => chordForBar(p, b))).toEqual([p[0], p[1], p[2], p[3], p[0], p[3]]);
  });

  it("has a strum pattern for every style and feel, inside the bar", () => {
    for (const s of STYLES)
      for (const f of [0, 1, 2] as const) {
        const pat = strumPattern(s, f);
        expect(pat.length).toBeGreaterThan(1);
        expect(pat[0]).toMatchObject({ step: 0, dir: "down" }); // always lands on beat 1
        for (const x of pat) expect(x.step).toBeGreaterThanOrEqual(0), expect(x.step).toBeLessThan(8);
      }
  });

  it("only accepts 4 known chords", () => {
    expect(isProgression(["G", "C", "D", "Em"])).toBe(true);
    expect(isProgression(["G", "C", "D"])).toBe(false);
    expect(isProgression(["G", "C", "D", "Xm"])).toBe(false);
  });

  it("plays at the set tempo and never ends on its own", () => {
    const c = new Conductor({ ...initialState(), auto: true, follow: false, bpm: 110 });
    c.start(1000);
    expect(c.state.transport.playing).toBe(true);
    expect(c.state.transport.segments[0].bpm).toBe(110);
    for (let now = 1000; now < 60000; now += 100) c.tick(now);
    expect(c.state.transport.endBeat).toBeNull();
  });

  it("changes feel by hand on the next bar", () => {
    const c = new Conductor({ ...initialState(), auto: true, follow: false, bpm: 120 });
    c.start(0);
    c.setFeel(3000, 2);
    const segs = c.state.transport.segments;
    expect(segs[segs.length - 1].feel).toBe(2);
    expect(segs[segs.length - 1].beat % 4).toBe(0);
  });

  it("turning auto off ends the jam and goes back to following strums", () => {
    const c = new Conductor({ ...initialState(), auto: true, follow: false });
    c.start(0);
    c.setAuto(5000, false);
    expect(c.state.follow).toBe(true);
    expect(c.state.transport.endBeat).not.toBeNull();
  });
});
