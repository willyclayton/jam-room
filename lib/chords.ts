// Open-position guitar voicings as MIDI notes, low E string first. null = string not played.

export type ChordName = "G" | "C" | "D" | "Em" | "Am" | "F";
export const CHORDS: ChordName[] = ["G", "C", "D", "Em", "Am", "F"];

export const VOICINGS: Record<ChordName, (number | null)[]> = {
  G: [43, 47, 50, 55, 59, 67], // 320003
  C: [null, 48, 52, 55, 60, 64], // x32010
  D: [null, null, 50, 57, 62, 66], // xx0232
  Em: [40, 47, 52, 55, 59, 64], // 022000
  Am: [null, 45, 52, 57, 60, 64], // x02210
  F: [41, 48, 53, 57, 60, 65], // 133211
};
