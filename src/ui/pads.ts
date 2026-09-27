import { noteName, type Slice } from '../slices';
import { sliceHue } from './waveform';

export const PADS_PER_BANK = 16;

// Keyboard rows mirror the pad grid: bottom row zxcv = pads 1–4 … top row 1234 = pads 13–16
const KEY_ROWS = ['zxcv', 'asdf', 'qwer', '1234'];
export const PAD_KEYS: Record<string, number> = Object.fromEntries(
  KEY_ROWS.flatMap((row, r) => [...row].map((k, c) => [k, r * 4 + c])),
);
const KEY_FOR_PAD = Object.fromEntries(Object.entries(PAD_KEYS).map(([k, i]) => [i, k]));

interface Callbacks {
  onPad(slice: Slice): void;
}

/** 4×4 pad grid, lowest slice bottom-left like a Drum Rack. */
export class PadGrid {
  bank = 0;
  private pads: HTMLButtonElement[] = [];
  private slices: Slice[] = [];
  private selected = -1;

  private sampleRate: () => number;
  private cb: Callbacks;

  constructor(el: HTMLElement, sampleRate: () => number, cb: Callbacks) {
    this.sampleRate = sampleRate;
    this.cb = cb;
    for (let i = 0; i < PADS_PER_BANK; i++) {
      const pad = document.createElement('button');
      pad.className = 'pad';
      const row = 3 - Math.floor(i / 4);
      pad.style.gridRow = String(row + 1);
      pad.style.gridColumn = String((i % 4) + 1);
      pad.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const s = this.slices[this.bank * PADS_PER_BANK + i];
        if (s) this.cb.onPad(s);
      });
      el.append(pad);
      this.pads.push(pad);
    }
  }

  get bankCount() {
    return Math.max(1, Math.ceil(this.slices.length / PADS_PER_BANK));
  }

  setBank(b: number) {
    this.bank = Math.min(Math.max(0, b), this.bankCount - 1);
    this.render();
  }

  setSlices(slices: Slice[]) {
    this.slices = slices;
    if (this.bank >= this.bankCount) this.bank = this.bankCount - 1;
    this.render();
  }

  select(index: number) {
    this.selected = index;
    if (index >= 0) this.bank = Math.floor(index / PADS_PER_BANK);
    this.render();
  }

  flash(index: number) {
    const local = index - this.bank * PADS_PER_BANK;
    const pad = this.pads[local];
    if (!pad || local < 0) return;
    pad.classList.remove('hit');
    void pad.offsetWidth; // restart the animation
    pad.classList.add('hit');
  }

  private render() {
    const sr = this.sampleRate();
    this.pads.forEach((pad, i) => {
      const s = this.slices[this.bank * PADS_PER_BANK + i];
      pad.disabled = !s;
      pad.classList.toggle('selected', !!s && s.index === this.selected);
      if (!s) {
        pad.innerHTML = `<span class="pad-key">${KEY_FOR_PAD[i] ?? ''}</span>`;
        pad.style.removeProperty('--hue');
        return;
      }
      const ms = ((s.end - s.start) / sr) * 1000;
      pad.style.setProperty('--hue', String(sliceHue(s.index)));
      pad.innerHTML = `
        <span class="pad-num">${s.index + 1}</span>
        <span class="pad-key">${KEY_FOR_PAD[i] ?? ''}</span>
        <span class="pad-note">${noteName(s.note)}</span>
        <span class="pad-len">${ms >= 1000 ? (ms / 1000).toFixed(2) + 's' : Math.round(ms) + 'ms'}</span>`;
    });
  }
}
