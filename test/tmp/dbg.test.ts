import { it } from "vitest";
import { Conductor } from "../../lib/conductor";
import { beatAtTime, beatMs, segmentAtTime } from "../../lib/transport";
for (const lat of [30, -30])
it("dbg " + lat, () => {
  const c = new Conductor();
  c.state.players = [{ id: "d", name: "", role: "drums", rtt: 5 }];
  const strums = [0, 581]; for (let k = 2; k < 24; k++) strums.push(581 + (k - 1) * 600);
  let i = 0; const out: string[] = [];
  for (let now = 0; now < 16000; now += 10) {
    while (i < strums.length && strums[i] + lat <= now) {
      const at = strums[i]; const tr = c.state.transport;
      if (tr.playing && tr.segments[0].time <= at) { const b = beatAtTime(tr.segments, at); out.push(String(Math.round((b - Math.round(b)) * beatMs(segmentAtTime(tr.segments, at).bpm)))); }
      c.strum(now, at, "G", 0.5); i++;
    }
    c.tick(now);
  }
  console.log("lat", lat, out.join(" "), c.state.bpm, JSON.stringify(c.state.transport.segments.slice(-3)));
});
