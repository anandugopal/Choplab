/**
 * Synthesises a two-bar drum loop so there's something to slice without a file.
 * Pure JS (no Web Audio) so it can also be used in tests.
 */
export interface DemoLoop {
  samples: Float32Array;
  sampleRate: number;
  bpm: number;
  /** Sample positions of every hit, for checking the detector. */
  hits: number[];
}

type Voice = 'kick' | 'snare' | 'hat' | 'open';

// 32 sixteenth-note steps
const PATTERN: [number, Voice, number][] = [
  [0, 'kick', 1], [2, 'hat', 0.5], [4, 'snare', 0.9], [6, 'hat', 0.5],
  [7, 'kick', 0.8], [8, 'hat', 0.5], [10, 'kick', 0.9], [12, 'snare', 0.9],
  [14, 'open', 0.45], [16, 'kick', 1], [18, 'hat', 0.5], [20, 'snare', 0.9],
  [22, 'hat', 0.5], [24, 'hat', 0.5], [25, 'kick', 0.7], [26, 'kick', 0.9],
  [28, 'snare', 0.9], [30, 'hat', 0.4], [31, 'snare', 0.35],
];

export function makeDemoLoop(sampleRate = 44100, bpm = 96, seed = 7): DemoLoop {
  const stepLen = (60 / bpm / 4) * sampleRate;
  const length = Math.round(stepLen * 32);
  const out = new Float32Array(length);
  let s = seed;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;

  const hits: number[] = [];
  for (const [step, voice, vel] of PATTERN) {
    // a touch of swing on off-beat 16ths
    const at = Math.round(step * stepLen + (step % 2 ? stepLen * 0.12 : 0));
    hits.push(at);
    render(out, at, voice, vel, sampleRate, rand);
  }
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < length; i++) out[i] = (out[i] / peak) * 0.9;
  return { samples: out, sampleRate, bpm, hits };
}

function render(
  out: Float32Array, at: number, voice: Voice, vel: number, sr: number, rand: () => number,
) {
  const dur = { kick: 0.45, snare: 0.3, hat: 0.06, open: 0.35 }[voice];
  const len = Math.min(out.length - at, Math.round(dur * sr));
  let phase = 0;
  let lp = 0;
  let prevN = 0;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    let v = 0;
    if (voice === 'kick') {
      const f = 45 + 110 * Math.exp(-t * 30);
      phase += (2 * Math.PI * f) / sr;
      v = Math.sin(phase) * Math.exp(-t * 7) + rand() * 0.15 * Math.exp(-t * 200);
    } else if (voice === 'snare') {
      phase += (2 * Math.PI * 185) / sr;
      const n = rand();
      lp += 0.5 * (n - lp);
      v = Math.sin(phase) * 0.5 * Math.exp(-t * 25) + lp * 0.9 * Math.exp(-t * 14);
    } else {
      const n = rand();
      const hp = n - prevN; // crude high-pass
      prevN = n;
      v = hp * 0.35 * Math.exp(-t * (voice === 'hat' ? 60 : 9));
    }
    const tail = Math.min(1, (len - i) / (0.01 * sr)); // fade the last 10ms so voices don't click off
    out[at + i] += v * vel * tail;
  }
}
