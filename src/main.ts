import './style.css';
import { analyzeOnsets } from './audio/analyze';
import { makeDemoLoop } from './audio/demo';
import { SamplerEngine, type Voice } from './audio/engine';
import { mixToMono } from './audio/onsets';
import { MAX_SLICES, noteName, SliceMap, type Slice, type SliceMode } from './slices';
import { PAD_KEYS, PADS_PER_BANK, PadGrid } from './ui/pads';
import { WaveformView } from './ui/waveform';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const engine = new SamplerEngine();
let map: SliceMap | null = null;
let selected = -1;
let preview: Voice | null = null;

const view = new WaveformView($<HTMLCanvasElement>('wave'), engine, {
  onSliceClick: (s) => trigger(s),
});
const pads = new PadGrid($('pads'), () => engine.buffer?.sampleRate ?? 44100, {
  onPad: (s) => trigger(s),
});
engine.onTrigger((e) => pads.flash(e.sliceIndex));

function trigger(s: Slice) {
  preview?.stop();
  preview = null;
  engine.playSlice(s);
  select(s.index);
}

function select(index: number) {
  selected = index;
  view.selected = index;
  view.invalidate();
  pads.select(index);
  updateBankLabel();
  const s = map?.slices[index];
  const sr = engine.buffer?.sampleRate ?? 44100;
  $('i-num').textContent = s ? String(s.index + 1) : '–';
  $('i-note').textContent = s ? `${noteName(s.note)} (${s.note})` : '–';
  $('i-start').textContent = s ? `${(s.start / sr).toFixed(3)}s` : '–';
  $('i-len').textContent = s ? `${(((s.end - s.start) / sr) * 1000).toFixed(0)}ms` : '–';
}

function updateBankLabel() {
  $('bank-label').textContent = `Bank ${String.fromCharCode(65 + pads.bank)}`;
  $<HTMLButtonElement>('bank-prev').disabled = pads.bank === 0;
  $<HTMLButtonElement>('bank-next').disabled = pads.bank >= pads.bankCount - 1;
}

function onMapChange() {
  if (!map) return;
  const slices = map.slices;
  pads.setSlices(slices);
  $('slice-count').textContent =
    `${slices.length} slice${slices.length === 1 ? '' : 's'}${slices.length >= MAX_SLICES ? ' (max)' : ''}`;
  select(Math.min(selected, slices.length - 1));
}

// ------------------------------------------------------------------ loading

async function loadBuffer(buffer: AudioBuffer, name: string) {
  engine.setBuffer(buffer);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  const mono = mixToMono(channels);

  map = new SliceMap(name, buffer.length, buffer.sampleRate);
  applyControls(map);
  map.addEventListener('change', onMapChange);
  view.setSample(mono, buffer.sampleRate, map);
  selected = -1;
  onMapChange();

  $('sample-name').textContent = `${name} · ${buffer.duration.toFixed(2)}s · ${buffer.sampleRate / 1000}kHz`;
  $('empty').hidden = true;
  $<HTMLButtonElement>('export-btn').disabled = false;

  const busy = $('busy');
  busy.hidden = false;
  const current = map;
  try {
    const candidates = await analyzeOnsets(mono, buffer.sampleRate);
    if (map === current) current.setCandidates(candidates);
  } finally {
    if (map === current) busy.hidden = true;
  }
}

function showError(msg: string) {
  const el = $('error');
  el.textContent = msg;
  el.hidden = false;
  setTimeout(() => (el.hidden = true), 5000);
}

async function loadFile(file: File) {
  try {
    const buffer = await engine.decode(await file.arrayBuffer());
    await loadBuffer(buffer, file.name);
  } catch (err) {
    console.error(err);
    showError(`Couldn't decode "${file.name}". Try a WAV, MP3, FLAC or OGG file.`);
  }
}

function loadDemo() {
  const demo = makeDemoLoop(engine.ctx.sampleRate);
  const buffer = engine.ctx.createBuffer(1, demo.samples.length, demo.sampleRate);
  buffer.copyToChannel(demo.samples as Float32Array<ArrayBuffer>, 0);
  void loadBuffer(buffer, `Demo loop (${demo.bpm} bpm)`);
}

// ------------------------------------------------------------------ controls

function applyControls(m: SliceMap) {
  m.mode = document.querySelector<HTMLButtonElement>('.seg .on')!.dataset.mode as SliceMode;
  m.sensitivity = Number($<HTMLInputElement>('sens').value) / 100;
  m.gridDivisions = Number($<HTMLSelectElement>('grid-div').value);
  m.resetEdits();
}

document.querySelectorAll<HTMLButtonElement>('.seg button').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll<HTMLButtonElement>('.seg button').forEach((x) => {
      x.classList.toggle('on', x === b);
      x.setAttribute('aria-checked', String(x === b));
    });
    const mode = b.dataset.mode as SliceMode;
    $('sens-ctl').hidden = mode !== 'transient';
    $('grid-ctl').hidden = mode !== 'grid';
    map?.setMode(mode);
  }),
);

$<HTMLInputElement>('sens').addEventListener('input', (e) => {
  const v = Number((e.target as HTMLInputElement).value);
  $('sens-out').textContent = `${v}%`;
  map?.setSensitivity(v / 100);
});
$<HTMLSelectElement>('grid-div').addEventListener('change', (e) =>
  map?.setGridDivisions(Number((e.target as HTMLSelectElement).value)),
);
$('reset-btn').addEventListener('click', () => map?.resetEdits());
$<HTMLInputElement>('mono').addEventListener('change', (e) => {
  engine.mono = (e.target as HTMLInputElement).checked;
});
$('zoom-in').addEventListener('click', () => view.zoom(0.5));
$('zoom-out').addEventListener('click', () => view.zoom(2));
$('zoom-fit').addEventListener('click', () => view.fit());
$('bank-prev').addEventListener('click', () => { pads.setBank(pads.bank - 1); updateBankLabel(); });
$('bank-next').addEventListener('click', () => { pads.setBank(pads.bank + 1); updateBankLabel(); });
$('demo-btn').addEventListener('click', loadDemo);
$('demo-link').addEventListener('click', loadDemo);
$<HTMLInputElement>('file-input').addEventListener('change', (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) void loadFile(f);
  (e.target as HTMLInputElement).value = '';
});
$('export-btn').addEventListener('click', () => {
  if (!map) return;
  const blob = new Blob([JSON.stringify(map.toJSON(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${map.sampleName.replace(/\.[^.]+$/, '')}.slices.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// ------------------------------------------------------------------ drag & drop

let dragDepth = 0;
const overlay = $('drop-overlay');
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  overlay.hidden = false;
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) { dragDepth = 0; overlay.hidden = true; }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  overlay.hidden = true;
  const f = [...(e.dataTransfer?.files ?? [])].find((f) => f.type.startsWith('audio/') || /\.(wav|mp3|aiff?|flac|ogg|m4a)$/i.test(f.name));
  if (f) void loadFile(f);
});

// ------------------------------------------------------------------ keyboard

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (!map) return;
  const slices = map.slices;
  const key = e.key.toLowerCase();

  if (key in PAD_KEYS) {
    if (e.repeat) return;
    const s = slices[pads.bank * PADS_PER_BANK + PAD_KEYS[key]];
    if (s) trigger(s);
    return;
  }
  switch (e.key) {
    case ' ': {
      e.preventDefault();
      if (preview && engine.activeVoices.has(preview)) {
        preview.stop();
        preview = null;
      } else {
        const from = selected >= 0 ? slices[selected].start : 0;
        preview = engine.preview(from, map.length);
      }
      break;
    }
    case 'ArrowRight':
    case 'ArrowLeft': {
      e.preventDefault();
      const i = Math.min(slices.length - 1, Math.max(0, selected + (e.key === 'ArrowRight' ? 1 : -1)));
      trigger(slices[i]);
      view.reveal(slices[i]);
      break;
    }
    case '[': pads.setBank(pads.bank - 1); updateBankLabel(); break;
    case ']': pads.setBank(pads.bank + 1); updateBankLabel(); break;
    case 'Delete':
    case 'Backspace':
      if (selected >= 0 && slices[selected]) map.removeMarker(slices[selected].id);
      break;
  }
});

updateBankLabel();

// Expose for the console and for a future sequencer module.
Object.assign(window, { choplab: { engine, get map() { return map; } } });
