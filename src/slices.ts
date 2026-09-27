import { pickOnsets, type OnsetCandidate } from './audio/onsets';

/**
 * Slice model shared by the slicer UI and (later) the sequencer.
 *
 * The sample is divided by an ordered list of markers; slice i runs from
 * marker i to marker i+1 (or the end of the sample). Like Ableton's
 * Slice to MIDI, slice i is played by MIDI note BASE_NOTE + i (C1 upward), so
 * a sequencer should address slices by `note` (or `index`), not by position.
 */

export const BASE_NOTE = 36; // C1 in Ableton's naming (C3 = 60)
export const MAX_SLICES = 64;

export type SliceMode = 'transient' | 'grid' | 'manual';
export type MarkerSource = 'auto' | 'manual';

export interface Marker {
  id: number;
  pos: number; // sample frame
  source: MarkerSource; // 'manual' markers survive sensitivity/grid changes
}

export interface Slice {
  id: number; // id of the marker that starts it; stable while that marker exists
  index: number;
  note: number;
  start: number; // sample frame, inclusive
  end: number; // sample frame, exclusive
}

export interface SliceMapJSON {
  sampleName: string;
  sampleRate: number;
  length: number;
  mode: SliceMode;
  sensitivity: number;
  gridDivisions: number;
  slices: Pick<Slice, 'index' | 'note' | 'start' | 'end'>[];
}

let nextId = 1;

export class SliceMap extends EventTarget {
  mode: SliceMode = 'transient';
  sensitivity = 0.5;
  gridDivisions = 16;
  markers: Marker[] = [];

  private candidates: OnsetCandidate[] = [];
  private suppressed: number[] = []; // auto positions the user deleted
  private cache: Slice[] | null = null;

  sampleName: string;
  length: number;
  sampleRate: number;

  constructor(sampleName: string, length: number, sampleRate: number) {
    super();
    this.sampleName = sampleName;
    this.length = length;
    this.sampleRate = sampleRate;
    this.regenerate();
  }

  /** Minimum distance between markers (30ms), matching the detector's peak window. */
  get minGap() {
    return Math.round(0.03 * this.sampleRate);
  }

  get slices(): Slice[] {
    if (!this.cache) {
      this.cache = this.markers.map((m, i) => ({
        id: m.id,
        index: i,
        note: BASE_NOTE + i,
        start: m.pos,
        end: this.markers[i + 1]?.pos ?? this.length,
      }));
    }
    return this.cache;
  }

  sliceAt(pos: number): Slice | undefined {
    return this.slices.find((s) => pos >= s.start && pos < s.end);
  }

  sliceForNote(note: number): Slice | undefined {
    return this.slices[note - BASE_NOTE];
  }

  setCandidates(c: OnsetCandidate[]) {
    this.candidates = c;
    if (this.mode === 'transient') this.regenerate();
  }

  setMode(mode: SliceMode) {
    this.mode = mode;
    this.resetEdits();
  }

  setSensitivity(s: number) {
    this.sensitivity = s;
    if (this.mode === 'transient') this.regenerate();
  }

  setGridDivisions(n: number) {
    this.gridDivisions = n;
    if (this.mode === 'grid') this.regenerate();
  }

  /** True when the user has added, moved or deleted slice points. */
  get hasEdits() {
    return this.suppressed.length > 0 || this.markers.some((m) => m.source === 'manual');
  }

  /** Drop manual markers and un-delete auto ones. */
  resetEdits() {
    this.markers = this.markers.filter((m) => m.source === 'auto');
    this.suppressed = [];
    this.regenerate();
  }

  addMarker(pos: number): Marker | null {
    pos = Math.round(Math.min(Math.max(0, pos), this.length - 1));
    if (this.markers.length >= MAX_SLICES) return null;
    if (this.markers.some((m) => Math.abs(m.pos - pos) < this.minGap / 3)) return null;
    const m: Marker = { id: nextId++, pos, source: 'manual' };
    this.markers.push(m);
    this.commit();
    return m;
  }

  /** Move a marker, keeping marker order. Moving an auto marker makes it manual. */
  moveMarker(id: number, pos: number) {
    const i = this.markers.findIndex((m) => m.id === id);
    if (i < 0) return;
    const pad = 64;
    const lo = i > 0 ? this.markers[i - 1].pos + pad : 0;
    const hi = i < this.markers.length - 1 ? this.markers[i + 1].pos - pad : this.length - pad;
    const m = this.markers[i];
    if (m.source === 'auto') {
      this.suppressed.push(m.pos);
      m.source = 'manual';
    }
    m.pos = Math.round(Math.min(Math.max(lo, pos), hi));
    this.commit();
  }

  removeMarker(id: number) {
    if (this.markers.length <= 1) return;
    const m = this.markers.find((m) => m.id === id);
    if (!m) return;
    if (m.source === 'auto') this.suppressed.push(m.pos);
    this.markers = this.markers.filter((x) => x !== m);
    this.commit();
  }

  toJSON(): SliceMapJSON {
    return {
      sampleName: this.sampleName,
      sampleRate: this.sampleRate,
      length: this.length,
      mode: this.mode,
      sensitivity: this.sensitivity,
      gridDivisions: this.gridDivisions,
      slices: this.slices.map(({ index, note, start, end }) => ({ index, note, start, end })),
    };
  }

  private autoPositions(): number[] {
    const gap = this.minGap;
    switch (this.mode) {
      case 'transient':
        return [0, ...pickOnsets(this.candidates.filter((c) => c.pos >= gap), this.sensitivity, gap, MAX_SLICES - 1)];
      case 'grid': {
        const n = Math.min(MAX_SLICES, this.gridDivisions);
        return Array.from({ length: n }, (_, i) => Math.round((i * this.length) / n));
      }
      case 'manual':
        return [0];
    }
  }

  private regenerate() {
    const gap = this.minGap;
    const manual = this.markers.filter((m) => m.source === 'manual');
    const prevAuto = new Map(this.markers.filter((m) => m.source === 'auto').map((m) => [m.pos, m.id]));
    const auto = this.autoPositions()
      .filter((p) => !this.suppressed.some((s) => Math.abs(s - p) < gap / 2))
      .filter((p) => !manual.some((m) => Math.abs(m.pos - p) < gap))
      .slice(0, MAX_SLICES - manual.length)
      .map((pos): Marker => ({ id: prevAuto.get(pos) ?? nextId++, pos, source: 'auto' }));
    this.markers = [...manual, ...auto];
    if (!this.markers.length) this.markers.push({ id: nextId++, pos: 0, source: 'auto' });
    this.commit();
  }

  private commit() {
    this.markers.sort((a, b) => a.pos - b.pos);
    this.cache = null;
    this.dispatchEvent(new Event('change'));
  }
}

export function noteName(note: number): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  return `${names[note % 12]}${Math.floor(note / 12) - 2}`;
}
