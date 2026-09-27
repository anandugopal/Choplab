import { noteName, type Slice } from '../slices';
import { STEPS_PER_BAR, STEPS_PER_BEAT, type Note, type Pattern } from '../sequencer/pattern';
import type { Sequencer } from '../sequencer/sequencer';
import { sliceHue } from './waveform';

const LABEL_W = 64;
const ROW_H = 18;
const MIN_STEP_W = 12;
const EDGE_PX = 5;
const VEL_H = 56;

interface Callbacks {
  onAudition(slice: Slice, velocity?: number): void;
}

type Drag =
  | { kind: 'move'; id: number; grab: number; moved: boolean }
  | { kind: 'resize'; id: number }
  | { kind: 'velocity' };

/**
 * Piano roll: one row per slice (highest on top, C1 at the bottom, like a
 * Slice to MIDI clip), 16th-note columns, and a velocity lane underneath.
 *
 *   click empty cell ....... add a note (drag right to lengthen it)
 *   click a note ........... delete it
 *   drag a note ............ move it in time or to another slice
 *   drag a note's end ...... change its length
 *   drag in velocity lane .. set velocity for notes starting in that column
 *   click a row label ...... audition the slice
 */
export class PianoRoll {
  selected = -1;

  private slices: Slice[] = [];
  private stepW = MIN_STEP_W;
  private width = 0;
  private drag: Drag | null = null;
  private lastLength = 1;
  private dirty = true;

  private roll: HTMLCanvasElement;
  private vel: HTMLCanvasElement;
  private rollScroll: HTMLElement;
  private outer: HTMLElement;
  private pattern: Pattern;
  private seq: Sequencer;
  private cb: Callbacks;

  constructor(
    els: { outer: HTMLElement; rollScroll: HTMLElement; roll: HTMLCanvasElement; vel: HTMLCanvasElement },
    pattern: Pattern,
    seq: Sequencer,
    cb: Callbacks,
  ) {
    this.outer = els.outer;
    this.rollScroll = els.rollScroll;
    this.roll = els.roll;
    this.vel = els.vel;
    this.pattern = pattern;
    this.seq = seq;
    this.cb = cb;

    pattern.addEventListener('change', () => this.layout());
    new ResizeObserver(() => this.layout()).observe(this.outer);

    this.roll.addEventListener('pointerdown', (e) => this.rollDown(e));
    this.roll.addEventListener('pointermove', (e) => this.rollMove(e));
    this.roll.addEventListener('pointerup', (e) => this.up(e, this.roll));
    this.roll.addEventListener('pointercancel', (e) => this.up(e, this.roll));
    this.roll.addEventListener('contextmenu', (e) => e.preventDefault());
    this.vel.addEventListener('pointerdown', (e) => {
      this.drag = { kind: 'velocity' };
      this.vel.setPointerCapture(e.pointerId);
      this.velAt(e);
    });
    this.vel.addEventListener('pointermove', (e) => this.drag?.kind === 'velocity' && this.velAt(e));
    this.vel.addEventListener('pointerup', (e) => this.up(e, this.vel));
    this.vel.addEventListener('pointercancel', (e) => this.up(e, this.vel));

    const loop = () => {
      if (this.dirty || this.seq.playing) this.draw();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  setSlices(slices: Slice[]) {
    const grew = slices.length !== this.slices.length;
    this.slices = slices;
    this.layout();
    if (grew) this.rollScroll.scrollTop = this.rollScroll.scrollHeight; // keep C1 in view
  }

  invalidate() {
    this.dirty = true;
  }

  private get rows() {
    return Math.max(1, this.slices.length);
  }

  private layout() {
    const avail = this.outer.clientWidth - (this.rollScroll.offsetWidth - this.rollScroll.clientWidth);
    const steps = this.pattern.steps;
    this.stepW = Math.max(MIN_STEP_W, (avail - LABEL_W) / steps);
    this.width = Math.floor(LABEL_W + this.stepW * steps);
    this.size(this.roll, this.width, this.rows * ROW_H);
    this.size(this.vel, this.width, VEL_H);
    this.invalidate();
  }

  private size(c: HTMLCanvasElement, w: number, h: number) {
    const dpr = window.devicePixelRatio || 1;
    if (c.width === Math.round(w * dpr) && c.height === Math.round(h * dpr)) return;
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    c.getContext('2d')!.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private css(name: string) {
    return getComputedStyle(this.roll).getPropertyValue(name).trim();
  }

  // row 0 is the top row, which is the highest slice
  private rowOfNote(note: number) {
    const idx = this.slices.findIndex((s) => s.note === note);
    return idx < 0 ? -1 : this.rows - 1 - idx;
  }

  private sliceOfRow(row: number): Slice | undefined {
    return this.slices[this.rows - 1 - row];
  }

  // ---------------------------------------------------------------- drawing

  private draw() {
    this.dirty = false;
    this.drawRoll();
    this.drawVelocity();
  }

  private drawGrid(ctx: CanvasRenderingContext2D, h: number) {
    const steps = this.pattern.steps;
    for (let b = 0; b < this.pattern.bars; b++) {
      ctx.fillStyle = b % 2 ? this.css('--roll-bar-alt') : this.css('--roll-bg');
      ctx.fillRect(LABEL_W + b * STEPS_PER_BAR * this.stepW, 0, STEPS_PER_BAR * this.stepW, h);
    }
    for (let s = 0; s <= steps; s++) {
      const x = Math.round(LABEL_W + s * this.stepW) + 0.5;
      ctx.fillStyle = s % STEPS_PER_BAR === 0 ? this.css('--roll-line-bar') : s % STEPS_PER_BEAT === 0 ? this.css('--roll-line-beat') : this.css('--roll-line');
      ctx.fillRect(x - 0.5, 0, 1, h);
    }
  }

  private drawPlayhead(ctx: CanvasRenderingContext2D, h: number) {
    const pos = this.seq.position();
    if (pos < 0) return;
    ctx.fillStyle = this.css('--playhead');
    ctx.fillRect(Math.round(LABEL_W + pos * this.stepW), 0, 2, h);
  }

  private drawRoll() {
    const ctx = this.roll.getContext('2d')!;
    const h = this.rows * ROW_H;
    ctx.clearRect(0, 0, this.width, h);
    this.drawGrid(ctx, h);

    // rows
    for (let r = 0; r < this.rows; r++) {
      const s = this.sliceOfRow(r);
      const y = r * ROW_H;
      if (s && s.index === this.selected) {
        ctx.fillStyle = `hsla(${sliceHue(s.index)}, 70%, 55%, 0.12)`;
        ctx.fillRect(LABEL_W, y, this.width - LABEL_W, ROW_H);
      }
      ctx.fillStyle = this.css('--roll-line');
      ctx.fillRect(LABEL_W, y + ROW_H - 1, this.width - LABEL_W, 1);
    }

    // notes
    for (const n of this.pattern.notes) {
      const r = this.rowOfNote(n.note);
      if (r < 0 || n.step >= this.pattern.steps) continue;
      const s = this.sliceOfRow(r)!;
      const x = LABEL_W + n.step * this.stepW;
      const w = Math.min(n.length, this.pattern.steps - n.step) * this.stepW;
      const hue = sliceHue(s.index);
      ctx.fillStyle = `hsl(${hue}, 70%, ${34 + n.velocity * 28}%)`;
      ctx.fillRect(x + 1, r * ROW_H + 1, w - 2, ROW_H - 3);
      ctx.fillStyle = `hsl(${hue}, 85%, 80%)`;
      ctx.fillRect(x + 1, r * ROW_H + 1, 2, ROW_H - 3);
    }

    this.drawPlayhead(ctx, h);

    // labels last so they sit above the grid
    ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'middle';
    for (let r = 0; r < this.rows; r++) {
      const s = this.sliceOfRow(r);
      const y = r * ROW_H;
      ctx.fillStyle = this.css('--ruler-bg');
      ctx.fillRect(0, y, LABEL_W, ROW_H);
      if (!s) continue;
      const hue = sliceHue(s.index);
      ctx.fillStyle = `hsl(${hue}, 70%, ${s.index === this.selected ? 65 : 45}%)`;
      ctx.fillRect(0, y + 1, 4, ROW_H - 2);
      ctx.fillStyle = this.css('--text');
      ctx.fillText(String(s.index + 1), 10, y + ROW_H / 2);
      ctx.fillStyle = this.css('--muted');
      ctx.fillText(noteName(s.note), 32, y + ROW_H / 2);
      ctx.fillStyle = this.css('--roll-line');
      ctx.fillRect(0, y + ROW_H - 1, LABEL_W, 1);
    }
    ctx.fillStyle = this.css('--line');
    ctx.fillRect(LABEL_W - 1, 0, 1, h);
  }

  private drawVelocity() {
    const ctx = this.vel.getContext('2d')!;
    ctx.clearRect(0, 0, this.width, VEL_H);
    this.drawGrid(ctx, VEL_H);
    ctx.fillStyle = this.css('--ruler-bg');
    ctx.fillRect(0, 0, LABEL_W, VEL_H);
    ctx.fillStyle = this.css('--muted');
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText('Velocity', 8, VEL_H / 2);
    ctx.fillStyle = this.css('--line');
    ctx.fillRect(0, 0, this.width, 1);
    ctx.fillRect(LABEL_W - 1, 0, 1, VEL_H);

    for (const n of this.pattern.notes) {
      const r = this.rowOfNote(n.note);
      if (r < 0 || n.step >= this.pattern.steps) continue;
      const hue = sliceHue(this.sliceOfRow(r)!.index);
      const x = LABEL_W + n.step * this.stepW + this.stepW / 2;
      const top = 4 + (1 - n.velocity) * (VEL_H - 8);
      ctx.fillStyle = `hsl(${hue}, 70%, 60%)`;
      ctx.fillRect(Math.round(x) - 1, top, 2, VEL_H - 4 - top);
      ctx.beginPath();
      ctx.arc(Math.round(x), top, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    this.drawPlayhead(ctx, VEL_H);
  }

  // ---------------------------------------------------------------- input

  private local(e: MouseEvent, c: HTMLCanvasElement) {
    const r = c.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private cell(x: number, y: number) {
    return {
      step: Math.floor((x - LABEL_W) / this.stepW),
      row: Math.min(this.rows - 1, Math.max(0, Math.floor(y / ROW_H))),
    };
  }

  private rollDown(e: PointerEvent) {
    if (!this.slices.length) return;
    const { x, y } = this.local(e, this.roll);
    const { step, row } = this.cell(x, y);
    const slice = this.sliceOfRow(row);
    if (!slice) return;
    if (x < LABEL_W) {
      this.cb.onAudition(slice);
      return;
    }
    if (step < 0 || step >= this.pattern.steps) return;

    const hit = this.pattern.noteAt(step, slice.note);
    if (hit && e.button === 2) {
      this.pattern.remove(hit.id);
      return;
    }
    if (e.button !== 0) return;
    this.roll.setPointerCapture(e.pointerId);
    if (hit) {
      const endX = LABEL_W + (hit.step + hit.length) * this.stepW;
      if (endX - x <= EDGE_PX + 2) {
        this.drag = { kind: 'resize', id: hit.id };
      } else {
        this.drag = { kind: 'move', id: hit.id, grab: step - hit.step, moved: false };
      }
      return;
    }
    const n = this.pattern.add({ step, length: this.lastLength, note: slice.note, velocity: 1 });
    this.cb.onAudition(slice);
    this.drag = { kind: 'resize', id: n.id };
  }

  private rollMove(e: PointerEvent) {
    const { x, y } = this.local(e, this.roll);
    const d = this.drag;
    if (!d) {
      this.hoverCursor(x, y);
      return;
    }
    const note = this.pattern.notes.find((n) => n.id === (d as { id?: number }).id);
    if (!note) return;
    if (d.kind === 'resize') {
      const len = Math.max(1, Math.round((x - LABEL_W) / this.stepW - note.step));
      const capped = Math.min(len, this.pattern.steps - note.step);
      if (capped !== note.length) {
        this.pattern.update(note.id, { length: capped });
        this.lastLength = capped;
      }
    } else if (d.kind === 'move') {
      const { step, row } = this.cell(x, y);
      const target = this.sliceOfRow(row);
      const newStep = Math.min(this.pattern.steps - 1, Math.max(0, step - d.grab));
      if (!target || (newStep === note.step && target.note === note.note)) return;
      d.moved = true;
      const pitchChanged = target.note !== note.note;
      this.pattern.update(note.id, { step: newStep, note: target.note });
      if (pitchChanged) this.cb.onAudition(target, note.velocity);
    }
  }

  private up(e: PointerEvent, c: HTMLCanvasElement) {
    const d = this.drag;
    this.drag = null;
    if (c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId);
    if (d?.kind === 'move' && !d.moved) this.pattern.remove(d.id);
  }

  private hoverCursor(x: number, y: number) {
    if (x < LABEL_W) {
      this.roll.style.cursor = 'pointer';
      return;
    }
    const { step, row } = this.cell(x, y);
    const s = this.sliceOfRow(row);
    const hit: Note | undefined = s && this.pattern.noteAt(step, s.note);
    if (!hit) this.roll.style.cursor = 'crosshair';
    else {
      const endX = LABEL_W + (hit.step + hit.length) * this.stepW;
      this.roll.style.cursor = endX - x <= EDGE_PX + 2 ? 'ew-resize' : 'grab';
    }
  }

  private velAt(e: PointerEvent) {
    const { x, y } = this.local(e, this.vel);
    const step = Math.floor((x - LABEL_W) / this.stepW);
    const v = 1 - (y - 4) / (VEL_H - 8);
    for (const n of this.pattern.notesAt(step)) this.pattern.update(n.id, { velocity: v });
  }
}
