import { BASE_NOTE, type Slice } from '../slices';

/**
 * A looping MIDI-style clip on a 16th-note grid. Notes address slices by MIDI
 * note (slice i = BASE_NOTE + i), so the pattern survives re-slicing: moving a
 * slice point changes what a note plays, not where the note is.
 */

export const STEPS_PER_BEAT = 4;
export const STEPS_PER_BAR = 16;
export const BAR_OPTIONS = [1, 2, 4, 8] as const;

export interface Note {
  id: number;
  step: number; // start, in 16th-note steps from the start of the loop
  length: number; // in steps, >= 1
  note: number; // MIDI note
  velocity: number; // 0..1
}

let nextId = 1;

export class Pattern extends EventTarget {
  bars = 2;
  notes: Note[] = [];

  get steps() {
    return this.bars * STEPS_PER_BAR;
  }

  setBars(bars: number) {
    this.bars = bars;
    this.changed();
  }

  add(n: Omit<Note, 'id'>): Note {
    const note = { ...n, id: nextId++ };
    // one note per step and pitch: replace whatever was there
    this.notes = this.notes.filter((x) => !(x.step === note.step && x.note === note.note));
    this.notes.push(note);
    this.changed();
    return note;
  }

  remove(id: number) {
    this.notes = this.notes.filter((n) => n.id !== id);
    this.changed();
  }

  update(id: number, patch: Partial<Omit<Note, 'id'>>) {
    const n = this.notes.find((x) => x.id === id);
    if (!n) return;
    Object.assign(n, patch);
    n.length = Math.max(1, Math.round(n.length));
    n.step = Math.max(0, Math.round(n.step));
    n.velocity = Math.min(1, Math.max(0.05, n.velocity));
    this.changed();
  }

  clear() {
    this.notes = [];
    this.changed();
  }

  /** Notes starting on `step` that fall inside the current loop. */
  notesAt(step: number): Note[] {
    return this.notes.filter((n) => n.step === step);
  }

  noteAt(step: number, note: number): Note | undefined {
    return this.notes.find((n) => n.note === note && step >= n.step && step < n.step + n.length);
  }

  /**
   * Like Ableton's Slice to MIDI: one note per slice at the slice's original
   * position (quantised to 16ths), held until the next slice.
   */
  fillFromSlices(slices: Slice[], sampleRate: number, bpm: number) {
    const stepSec = 60 / bpm / STEPS_PER_BEAT;
    const placed = new Map<number, Omit<Note, 'id'>>();
    for (const s of slices) {
      const step = Math.round(s.start / sampleRate / stepSec);
      if (step >= this.steps || placed.has(step)) continue;
      placed.set(step, { step, length: 1, note: s.note, velocity: 1 });
    }
    const sorted = [...placed.values()].sort((a, b) => a.step - b.step);
    sorted.forEach((n, i) => {
      const next = sorted[i + 1]?.step ?? this.steps;
      n.length = Math.max(1, next - n.step);
    });
    this.notes = sorted.map((n) => ({ ...n, id: nextId++ }));
    this.changed();
  }

  toJSON() {
    return { bars: this.bars, notes: this.notes.map(({ id: _id, ...n }) => n) };
  }

  private changed() {
    this.dispatchEvent(new Event('change'));
  }
}

/**
 * Guess tempo and loop length for a sample, assuming it's a loop of 1–8 whole
 * bars in 4/4 and picking the reading closest to 120 bpm within 80–165 bpm.
 * Returns null for anything that doesn't look like a short loop.
 */
export function estimateLoop(durationSec: number): { bpm: number; bars: number } | null {
  let best: { bpm: number; bars: number } | null = null;
  for (const bars of BAR_OPTIONS) {
    const bpm = (60 * 4 * bars) / durationSec;
    if (bpm < 80 || bpm > 165) continue;
    if (!best || Math.abs(bpm - 120) < Math.abs(best.bpm - 120)) best = { bpm, bars };
  }
  return best && { bpm: Math.round(best.bpm * 100) / 100, bars: best.bars };
}

export const noteToSliceIndex = (note: number) => note - BASE_NOTE;
