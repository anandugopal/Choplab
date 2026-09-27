import type { SamplerEngine } from '../audio/engine';
import { snapToZeroCrossing } from '../audio/onsets';
import type { Marker, Slice, SliceMap } from '../slices';

export const sliceHue = (i: number) => (i * 47 + 190) % 360;

const RULER_H = 20;
const OVERVIEW_H = 22;
const HIT_PX = 6;
const MIP_BLOCK = 256;

interface Callbacks {
  onSliceClick(slice: Slice): void;
}

/**
 * Canvas waveform with zoom/scroll, coloured slice regions and draggable
 * slice markers.
 *
 *   drag marker ............ move slice point
 *   double-click ........... add slice point
 *   right-click marker ..... delete slice point
 *   click region ........... select + play slice
 *   wheel / pinch .......... zoom, shift+wheel or trackpad swipe to scroll
 *   overview strip ......... click or drag to scroll
 */
export class WaveformView {
  selected = -1;

  private ctx: CanvasRenderingContext2D;
  private mono: Float32Array | null = null;
  private mipMin = new Float32Array(0);
  private mipMax = new Float32Array(0);
  private overviewCache: HTMLCanvasElement | null = null;
  private map: SliceMap | null = null;
  private sampleRate = 44100;

  private viewStart = 0; // sample at left edge
  private spp = 1; // samples per CSS pixel
  private w = 0;
  private h = 0;
  private dirty = true;
  private hoverMarker: Marker | null = null;
  private drag: { kind: 'marker'; id: number } | { kind: 'overview' } | null = null;

  private canvas: HTMLCanvasElement;
  private engine: SamplerEngine;
  private cb: Callbacks;

  constructor(canvas: HTMLCanvasElement, engine: SamplerEngine, cb: Callbacks) {
    this.canvas = canvas;
    this.engine = engine;
    this.cb = cb;
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(canvas);
    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
    canvas.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    canvas.addEventListener('dblclick', (e) => this.onDoubleClick(e));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    const loop = () => {
      if (this.dirty || this.engine.activeVoices.size) this.draw();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  setSample(mono: Float32Array, sampleRate: number, map: SliceMap) {
    this.mono = mono;
    this.sampleRate = sampleRate;
    this.map = map;
    map.addEventListener('change', () => this.invalidate());
    const blocks = Math.ceil(mono.length / MIP_BLOCK);
    this.mipMin = new Float32Array(blocks);
    this.mipMax = new Float32Array(blocks);
    for (let b = 0; b < blocks; b++) {
      let lo = 0;
      let hi = 0;
      const end = Math.min(mono.length, (b + 1) * MIP_BLOCK);
      for (let i = b * MIP_BLOCK; i < end; i++) {
        const v = mono[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      this.mipMin[b] = lo;
      this.mipMax[b] = hi;
    }
    this.overviewCache = null;
    this.selected = -1;
    this.fit();
  }

  fit() {
    if (!this.mono || !this.w) return;
    this.spp = this.mono.length / this.w;
    this.viewStart = 0;
    this.invalidate();
  }

  zoom(factor: number, anchorX = this.w / 2) {
    if (!this.mono) return;
    const anchor = this.viewStart + anchorX * this.spp;
    this.spp = Math.min(this.mono.length / this.w, Math.max(1 / 16, this.spp * factor));
    this.viewStart = anchor - anchorX * this.spp;
    this.clampView();
  }

  /** Scroll so that a slice is visible, zooming in if the view is fitted. */
  reveal(slice: Slice) {
    const a = this.xOf(slice.start);
    const b = this.xOf(slice.end);
    if (a < 0 || b > this.w) {
      this.viewStart = (slice.start + slice.end) / 2 - (this.w * this.spp) / 2;
      this.clampView();
    }
  }

  invalidate() {
    this.dirty = true;
  }

  private clampView() {
    if (!this.mono) return;
    const span = this.w * this.spp;
    this.viewStart = Math.min(Math.max(0, this.viewStart), Math.max(0, this.mono.length - span));
    this.invalidate();
  }

  private resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    const fitted = this.mono && this.w && Math.abs(this.spp - this.mono.length / this.w) < 1e-6;
    this.w = r.width;
    this.h = r.height;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.overviewCache = null;
    if (fitted || this.spp === 1) this.fit();
    else this.clampView();
  }

  private xOf(frame: number) {
    return (frame - this.viewStart) / this.spp;
  }

  private frameAt(x: number) {
    return this.viewStart + x * this.spp;
  }

  private css(name: string) {
    return getComputedStyle(this.canvas).getPropertyValue(name).trim();
  }

  // ---------------------------------------------------------------- drawing

  private draw() {
    this.dirty = false;
    const { ctx, w, h } = this;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = this.css('--wave-bg');
    ctx.fillRect(0, 0, w, h);
    if (!this.mono || !this.map) return;

    const waveTop = RULER_H;
    const waveH = h - RULER_H - OVERVIEW_H;
    const mid = waveTop + waveH / 2;
    const amp = (waveH / 2) * 0.92;
    const slices = this.map.slices;

    // slice regions
    for (const s of slices) {
      const x0 = Math.max(0, this.xOf(s.start));
      const x1 = Math.min(w, this.xOf(s.end));
      if (x1 <= 0 || x0 >= w) continue;
      const hue = sliceHue(s.index);
      ctx.fillStyle = `hsla(${hue}, 70%, 55%, ${s.index === this.selected ? 0.22 : s.index % 2 ? 0.07 : 0.11})`;
      ctx.fillRect(x0, waveTop, x1 - x0, waveH);
    }

    // centre line
    ctx.fillStyle = this.css('--wave-grid');
    ctx.fillRect(0, Math.round(mid), w, 1);

    // waveform, coloured per slice
    let si = 0;
    const cols = Math.ceil(w);
    let current = '';
    ctx.beginPath();
    for (let x = 0; x < cols; x++) {
      const a = this.frameAt(x);
      const b = this.frameAt(x + 1);
      while (si < slices.length - 1 && slices[si].end <= a) si++;
      const color = `hsl(${sliceHue(slices[si].index)}, 75%, ${slices[si].index === this.selected ? 72 : 64}%)`;
      if (color !== current) {
        if (current) { ctx.strokeStyle = current; ctx.stroke(); ctx.beginPath(); }
        current = color;
      }
      const [lo, hi] = this.range(a, b);
      if (hi === lo && lo === 0) continue;
      ctx.moveTo(x + 0.5, mid - hi * amp);
      ctx.lineTo(x + 0.5, mid - lo * amp + 1);
    }
    ctx.strokeStyle = current;
    ctx.lineWidth = 1;
    ctx.stroke();

    this.drawRuler();

    // markers
    ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'middle';
    for (const [i, m] of this.map.markers.entries()) {
      const x = Math.round(this.xOf(m.pos)) + 0.5;
      if (x < -40 || x > w + 1) continue;
      const hot = this.hoverMarker?.id === m.id || (this.drag?.kind === 'marker' && this.drag.id === m.id);
      const color = m.source === 'manual' ? this.css('--marker-manual') : this.css('--marker-auto');
      ctx.strokeStyle = color;
      ctx.globalAlpha = hot ? 1 : 0.75;
      ctx.lineWidth = hot ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(x, RULER_H);
      ctx.lineTo(x, waveTop + waveH);
      ctx.stroke();
      ctx.globalAlpha = 1;
      // flag with slice number
      const label = String(i + 1);
      const fw = ctx.measureText(label).width + 8;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(x, 2);
      ctx.lineTo(x + fw, 2);
      ctx.lineTo(x + fw, RULER_H - 5);
      ctx.lineTo(x + 5, RULER_H - 5);
      ctx.lineTo(x, RULER_H);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = this.css('--marker-text');
      ctx.fillText(label, x + 4, (RULER_H - 3) / 2 + 1);
    }
    ctx.lineWidth = 1;

    // playheads
    const now = this.engine.ctx.currentTime;
    ctx.fillStyle = this.css('--playhead');
    for (const v of this.engine.activeVoices) {
      const f = v.startFrame + Math.max(0, now - v.startTime) * this.sampleRate;
      if (f > v.endFrame) continue;
      ctx.fillRect(Math.round(this.xOf(f)), waveTop, 2, waveH);
    }

    this.drawOverview();
  }

  /** min/max of the mono signal over [a, b) */
  private range(a: number, b: number): [number, number] {
    const x = this.mono!;
    let lo = 0;
    let hi = 0;
    if (b - a >= MIP_BLOCK * 2) {
      const b0 = Math.max(0, Math.floor(a / MIP_BLOCK));
      const b1 = Math.min(this.mipMin.length, Math.ceil(b / MIP_BLOCK));
      for (let i = b0; i < b1; i++) {
        if (this.mipMin[i] < lo) lo = this.mipMin[i];
        if (this.mipMax[i] > hi) hi = this.mipMax[i];
      }
      return [lo, hi];
    }
    const i0 = Math.max(0, Math.floor(a));
    const i1 = Math.min(x.length, Math.max(i0 + 1, Math.ceil(b)));
    if (i0 >= x.length) return [0, 0];
    lo = hi = x[i0];
    for (let i = i0 + 1; i < i1; i++) {
      if (x[i] < lo) lo = x[i];
      if (x[i] > hi) hi = x[i];
    }
    // when zoomed past 1 sample/pixel, connect to the next sample
    if (b - a < 1 && i0 + 1 < x.length) {
      const next = x[i0 + 1];
      if (next < lo) lo = next;
      if (next > hi) hi = next;
    }
    return [lo, hi];
  }

  private drawRuler() {
    const { ctx, w } = this;
    ctx.fillStyle = this.css('--ruler-bg');
    ctx.fillRect(0, 0, w, RULER_H);
    const secPerPx = this.spp / this.sampleRate;
    const steps = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60];
    const step = steps.find((s) => s / secPerPx >= 80) ?? 60;
    const t0 = Math.ceil(this.viewStart / this.sampleRate / step) * step;
    ctx.fillStyle = this.css('--ruler-text');
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'bottom';
    for (let t = t0; ; t += step) {
      const x = Math.round(this.xOf(t * this.sampleRate)) + 0.5;
      if (x > w) break;
      ctx.fillRect(x, RULER_H - 5, 1, 5);
      const digits = step < 0.01 ? 3 : step < 0.1 ? 2 : step < 1 ? 2 : 0;
      ctx.fillText(`${t.toFixed(digits)}s`, x + 3, RULER_H - 2);
    }
  }

  private drawOverview() {
    const { ctx, w, h } = this;
    const top = h - OVERVIEW_H;
    if (!this.overviewCache) {
      const dpr = window.devicePixelRatio || 1;
      const c = document.createElement('canvas');
      c.width = Math.round(w * dpr);
      c.height = Math.round(OVERVIEW_H * dpr);
      const o = c.getContext('2d')!;
      o.scale(dpr, 1 * dpr);
      o.fillStyle = this.css('--ruler-bg');
      o.fillRect(0, 0, w, OVERVIEW_H);
      o.fillStyle = this.css('--overview-wave');
      const perPx = this.mono!.length / w;
      for (let x = 0; x < w; x++) {
        const [lo, hi] = this.range(x * perPx, (x + 1) * perPx);
        const m = OVERVIEW_H / 2;
        o.fillRect(x, m - hi * m * 0.9, 1, Math.max(1, (hi - lo) * m * 0.9));
      }
      this.overviewCache = c;
    }
    ctx.drawImage(this.overviewCache, 0, top, w, OVERVIEW_H);
    const total = this.mono!.length;
    const vx = (this.viewStart / total) * w;
    const vw = Math.max(4, ((this.w * this.spp) / total) * w);
    ctx.strokeStyle = this.css('--accent');
    ctx.lineWidth = 1;
    ctx.strokeRect(vx + 0.5, top + 0.5, vw - 1, OVERVIEW_H - 1);
    ctx.fillStyle = this.css('--accent');
    ctx.globalAlpha = 0.12;
    ctx.fillRect(vx, top, vw, OVERVIEW_H);
    ctx.globalAlpha = 1;
  }

  // ---------------------------------------------------------------- input

  private local(e: MouseEvent) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private markerAt(x: number, y: number): Marker | null {
    if (!this.map || y > this.h - OVERVIEW_H) return null;
    let best: Marker | null = null;
    let bestD = Infinity;
    for (const m of this.map.markers) {
      const mx = this.xOf(m.pos);
      // the flag in the ruler is a wider grab target
      const inFlag = y <= RULER_H && x >= mx - 2 && x <= mx + 22;
      const d = Math.abs(mx - x);
      if ((d <= HIT_PX || inFlag) && d < bestD) {
        best = m;
        bestD = d;
      }
    }
    return best;
  }

  private onPointerDown(e: PointerEvent) {
    if (!this.map || !this.mono) return;
    const { x, y } = this.local(e);
    if (y > this.h - OVERVIEW_H) {
      this.drag = { kind: 'overview' };
      this.canvas.setPointerCapture(e.pointerId);
      this.scrollOverviewTo(x);
      return;
    }
    const m = this.markerAt(x, y);
    if (m && e.button === 2) {
      this.map.removeMarker(m.id);
      this.hoverMarker = null;
      return;
    }
    if (m && e.button === 0) {
      this.drag = { kind: 'marker', id: m.id };
      this.canvas.setPointerCapture(e.pointerId);
      this.invalidate();
      return;
    }
    if (e.button === 0) {
      const s = this.map.sliceAt(this.frameAt(x));
      if (s) this.cb.onSliceClick(s);
    }
  }

  private onPointerMove(e: PointerEvent) {
    if (!this.map) return;
    const { x, y } = this.local(e);
    if (this.drag?.kind === 'overview') {
      this.scrollOverviewTo(x);
      return;
    }
    if (this.drag?.kind === 'marker') {
      // hold alt to disable zero-crossing snap
      const f = this.frameAt(x);
      const pos = e.altKey ? f : snapToZeroCrossing(this.mono!, f, Math.max(8, Math.round(this.spp * 2)));
      this.map.moveMarker(this.drag.id, pos);
      return;
    }
    const m = this.markerAt(x, y);
    if (m?.id !== this.hoverMarker?.id) {
      this.hoverMarker = m;
      this.invalidate();
    }
    this.canvas.style.cursor = y > this.h - OVERVIEW_H ? 'grab' : m ? 'ew-resize' : 'pointer';
  }

  private onPointerUp(e: PointerEvent) {
    if (this.drag) this.canvas.releasePointerCapture(e.pointerId);
    this.drag = null;
    this.invalidate();
  }

  private onDoubleClick(e: MouseEvent) {
    if (!this.map || !this.mono) return;
    const { x, y } = this.local(e);
    if (y > this.h - OVERVIEW_H || this.markerAt(x, y)) return;
    this.map.addMarker(snapToZeroCrossing(this.mono, this.frameAt(x), Math.max(8, Math.round(this.spp * 2))));
  }

  private onWheel(e: WheelEvent) {
    if (!this.mono) return;
    e.preventDefault();
    const { x } = this.local(e);
    const scale = e.deltaMode === 1 ? 16 : 1;
    const dx = e.deltaX * scale;
    const dy = e.deltaY * scale;
    if (e.shiftKey || Math.abs(dx) > Math.abs(dy)) {
      this.viewStart += (e.shiftKey ? dy || dx : dx) * this.spp;
      this.clampView();
    } else {
      this.zoom(Math.exp(dy * (e.ctrlKey ? 0.01 : 0.0025)), x);
    }
  }

  private scrollOverviewTo(x: number) {
    const total = this.mono!.length;
    this.viewStart = (x / this.w) * total - (this.w * this.spp) / 2;
    this.clampView();
  }
}
