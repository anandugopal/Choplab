import './style.css';
import { analyzeOnsets } from './audio/analyze';
import { makeDemoLoop } from './audio/demo';
import { SamplerEngine, type Voice } from './audio/engine';
import { mixToMono } from './audio/onsets';
import { MAX_SLICES, noteName, SliceMap, type Slice, type SliceMode } from './slices';
import { estimateLoop, Pattern } from './sequencer/pattern';
import { Sequencer } from './sequencer/sequencer';
import { PAD_KEYS, PADS_PER_BANK, PadGrid } from './ui/pads';
import { PianoRoll } from './ui/pianoroll';
import { sliceHue, WaveformView } from './ui/waveform';
import { Background } from './visuals/background';

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
engine.onTrigger((e) => {
  // pads flash when the note actually sounds, not when it's booked ahead
  const delay = Math.max(0, (e.time - engine.ctx.currentTime) * 1000);
  setTimeout(() => pads.flash(e.sliceIndex), delay);
});

// ------------------------------------------------------------------ sequencer

const pattern = new Pattern();
const seq = new Sequencer(engine.ctx, pattern, (n, time, duration) => {
  const s = map?.sliceForNote(n.note);
  if (s) engine.playSlice(s, { time, duration, velocity: n.velocity });
});
const roll = new PianoRoll(
  { outer: $('roll-outer'), rollScroll: $('roll-scroll'), roll: $<HTMLCanvasElement>('roll'), vel: $<HTMLCanvasElement>('vel') },
  pattern,
  seq,
  { onAudition: (s, v) => { engine.playSlice(s, { velocity: v }); select(s.index); } },
);
let recording = false;

// ------------------------------------------------------------------ visuals

const VIS_KEY = 'choplab.visuals';
const bg = new Background($<HTMLCanvasElement>('bg'), engine);

function setVisuals(on: boolean) {
  bg.setEnabled(on);
  document.body.classList.toggle('visuals-on', bg.on);
  $('vis-btn').setAttribute('aria-pressed', String(bg.on));
  // the waveform and piano roll paint their backgrounds from CSS variables
  view.invalidate();
  roll.invalidate();
  try { localStorage.setItem(VIS_KEY, bg.on ? '1' : '0'); } catch { /* storage blocked */ }
}

{
  const btn = $<HTMLButtonElement>('vis-btn');
  if (!bg.supported) {
    btn.disabled = true;
    btn.title = 'Visuals need WebGL 2';
  }
  btn.addEventListener('click', () => setVisuals(!bg.on));
  let saved: string | null = null;
  try { saved = localStorage.getItem(VIS_KEY); } catch { /* storage blocked */ }
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  setVisuals(saved ? saved === '1' : !calm);
}

function setPlaying(on: boolean) {
  if (on) {
    if (!map) return;
    preview?.stop();
    preview = null;
    seq.start();
  } else {
    seq.stop();
    engine.stopAll();
  }
}

seq.addEventListener('state', () => {
  const on = seq.playing;
  $('play-btn').setAttribute('aria-pressed', String(on));
  $('play-label').textContent = on ? 'Stop' : 'Play';
  $('play-icon').setAttribute('d', on ? 'M3.5 3.5h9v9h-9z' : 'M4 2.5v11l9-5.5z');
  roll.invalidate();
});

function setRecording(on: boolean) {
  recording = on;
  $('rec-btn').setAttribute('aria-pressed', String(on));
}

function setTempo(bpm: number) {
  seq.bpm = Math.min(240, Math.max(40, bpm));
  $<HTMLInputElement>('bpm').value = String(Math.round(seq.bpm * 100) / 100);
}

function setBars(bars: number) {
  pattern.setBars(bars);
  $<HTMLSelectElement>('bars').value = String(bars);
}

/** When recording, write a played slice onto the nearest 16th. */
function recordHit(s: Slice) {
  if (!recording || !seq.playing) return;
  // compensate for output latency so hits land where they were heard
  const latency = engine.ctx.outputLatency || engine.ctx.baseLatency || 0;
  const pos = seq.position() - latency / seq.stepDuration;
  if (pos < 0) return;
  const step = Math.round(pos) % pattern.steps;
  if (!pattern.noteAt(step, s.note)) pattern.add({ step, length: 1, note: s.note, velocity: 1 });
}

$('play-btn').addEventListener('click', () => setPlaying(!seq.playing));
$('rec-btn').addEventListener('click', () => setRecording(!recording));
$<HTMLInputElement>('bpm').addEventListener('change', (e) => setTempo(Number((e.target as HTMLInputElement).value) || 120));
$<HTMLInputElement>('swing').addEventListener('input', (e) => {
  const v = Number((e.target as HTMLInputElement).value);
  seq.swing = v / 100;
  $('swing-out').textContent = `${v}%`;
});
$<HTMLSelectElement>('bars').addEventListener('change', (e) => pattern.setBars(Number((e.target as HTMLSelectElement).value)));
$('fill-btn').addEventListener('click', () => {
  if (map) pattern.fillFromSlices(map.slices, map.sampleRate, seq.bpm);
});
$('clear-btn').addEventListener('click', () => pattern.clear());

function trigger(s: Slice) {
  if (!seq.playing) {
    preview?.stop();
    preview = null;
  }
  engine.playSlice(s);
  recordHit(s);
  select(s.index);
}

function select(index: number) {
  selected = index;
  view.selected = index;
  view.invalidate();
  roll.selected = index;
  roll.invalidate();
  pads.select(index);
  updateBankLabel();
  updateReadout();
}

/** Selected slice and slice count, in the slicer's header. */
function updateReadout() {
  const el = $('slice-readout');
  if (!map) {
    el.textContent = '';
    return;
  }
  const slices = map.slices;
  const count = `${slices.length} slice${slices.length === 1 ? '' : 's'}${slices.length >= MAX_SLICES ? ' (max)' : ''}`;
  const s = slices[selected];
  if (!s) {
    el.innerHTML = `${count}<span class="sep">·</span>click one to hear it`;
    return;
  }
  const sr = map.sampleRate;
  const ms = ((s.end - s.start) / sr) * 1000;
  const len = ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
  el.innerHTML =
    `<span class="sw" style="background:hsl(${sliceHue(s.index)} 75% 62%)"></span>` +
    `<b>Slice ${s.index + 1}</b> of ${slices.length}<span class="sep">·</span>${noteName(s.note)}` +
    `<span class="sep">·</span>${(s.start / sr).toFixed(3)}s<span class="sep">·</span>${len}`;
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
  roll.setSlices(slices);
  $('reset-btn').hidden = !map.hasEdits;
  select(Math.min(selected, slices.length - 1));
}

// ------------------------------------------------------------------ loading

/** For short loops, guess the tempo and lay the slices out as a pattern. */
function autoFill(m: SliceMap) {
  const loop = estimateLoop(m.length / m.sampleRate);
  if (!loop) {
    pattern.clear();
    return;
  }
  setTempo(loop.bpm);
  setBars(loop.bars);
  pattern.fillFromSlices(m.slices, m.sampleRate, loop.bpm);
}

async function loadBuffer(buffer: AudioBuffer, name: string) {
  setPlaying(false);
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
  document.body.classList.add('loaded');
  for (const id of ['export-btn', 'play-btn', 'rec-btn']) $<HTMLButtonElement>(id).disabled = false;

  const busy = $('busy');
  busy.hidden = false;
  const current = map;
  try {
    const candidates = await analyzeOnsets(mono, buffer.sampleRate);
    if (map === current) {
      current.setCandidates(candidates);
      autoFill(current);
    }
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
$('mono').addEventListener('click', () => {
  engine.mono = !engine.mono;
  $('mono').setAttribute('aria-pressed', String(engine.mono));
});
$('zoom-in').addEventListener('click', () => view.zoom(0.5));
$('zoom-out').addEventListener('click', () => view.zoom(2));
$('zoom-fit').addEventListener('click', () => view.fit());
$('bank-prev').addEventListener('click', () => { pads.setBank(pads.bank - 1); updateBankLabel(); });
$('bank-next').addEventListener('click', () => { pads.setBank(pads.bank + 1); updateBankLabel(); });
$('demo-btn').addEventListener('click', loadDemo);
$('demo-link').addEventListener('click', loadDemo);
for (const id of ['file-input', 'file-input-2']) {
  $<HTMLInputElement>(id).addEventListener('change', (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) void loadFile(f);
    (e.target as HTMLInputElement).value = '';
  });
}

// ------------------------------------------------------------------ help

const help = $<HTMLDialogElement>('help');
const toggleHelp = () => (help.open ? help.close() : help.showModal());
$('help-btn').addEventListener('click', toggleHelp);
$('help-close').addEventListener('click', () => help.close());
help.addEventListener('click', (e) => { if (e.target === help) help.close(); }); // backdrop
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
  if (e.key === '?') {
    toggleHelp();
    return;
  }
  if (help.open) return;
  if (e.key.toLowerCase() === 'v' && e.shiftKey) {
    if (!e.repeat) setVisuals(!bg.on);
    return;
  }
  if (!map) return;
  const slices = map.slices;
  const key = e.key.toLowerCase();

  if (key === 'r' && e.shiftKey) {
    if (!e.repeat) setRecording(!recording);
    return;
  }
  if (key in PAD_KEYS) {
    if (e.repeat) return;
    const s = slices[pads.bank * PADS_PER_BANK + PAD_KEYS[key]];
    if (s) trigger(s);
    return;
  }
  switch (e.key) {
    case ' ': {
      e.preventDefault();
      if (!e.shiftKey) {
        setPlaying(!seq.playing);
        break;
      }
      setPlaying(false);
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

// Expose for the console.
Object.assign(window, { choplab: { engine, pattern, seq, bg, get map() { return map; } } });
