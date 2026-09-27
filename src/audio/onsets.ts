import { createFFT } from './fft';

/**
 * A possible slice point found by the onset detector. `strength` is normalised
 * to 0..1 against the strongest transient in the file, so the sensitivity
 * control can re-pick slices instantly without re-analysing the audio.
 */
export interface OnsetCandidate {
  pos: number; // sample frame where the attack starts
  strength: number;
}

/** Downmix an AudioBuffer-like set of channels to mono. */
export function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0].length);
  for (const ch of channels) for (let i = 0; i < out.length; i++) out[i] += ch[i];
  const g = 1 / channels.length;
  for (let i = 0; i < out.length; i++) out[i] *= g;
  return out;
}

/**
 * Spectral-flux onset detection with an adaptive median threshold, followed by
 * a time-domain pass that pulls each onset back to the true start of the
 * attack (so slices don't clip the front of a hit).
 */
export function detectOnsetCandidates(x: Float32Array, sampleRate: number): OnsetCandidate[] {
  // ~23ms window at 44.1/48k, 75% overlap
  const n = 2 ** Math.round(Math.log2(sampleRate / 43));
  const hop = n / 4;
  const bins = n / 2;
  const frames = Math.max(0, Math.floor((x.length - n) / hop) + 1);
  if (frames < 3) return [];

  const fft = createFFT(n);
  const win = new Float64Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);

  const re = new Float64Array(n);
  const im = new Float64Array(n);
  let prev = new Float64Array(bins);
  let cur = new Float64Array(bins);
  const flux = new Float64Array(frames);

  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    for (let i = 0; i < n; i++) {
      re[i] = x[off + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    let sum = 0;
    for (let k = 1; k < bins; k++) {
      // log compression keeps quiet hits from being drowned by loud ones
      const mag = Math.log1p(100 * Math.hypot(re[k], im[k]));
      cur[k] = mag;
      if (f > 0) {
        const d = mag - prev[k];
        if (d > 0) sum += d;
      }
    }
    flux[f] = sum;
    const t = prev; prev = cur; cur = t;
  }

  // Adaptive threshold: moving median over ~±100ms plus a small floor
  const half = Math.max(2, Math.round((0.1 * sampleRate) / hop));
  let maxFlux = 0;
  for (let f = 0; f < frames; f++) maxFlux = Math.max(maxFlux, flux[f]);
  if (maxFlux <= 0) return [];
  const floor = maxFlux * 0.01;
  const odf = new Float64Array(frames);
  const scratch: number[] = [];
  for (let f = 0; f < frames; f++) {
    scratch.length = 0;
    for (let j = Math.max(0, f - half); j <= Math.min(frames - 1, f + half); j++) scratch.push(flux[j]);
    scratch.sort((a, b) => a - b);
    const med = scratch[scratch.length >> 1];
    odf[f] = Math.max(0, flux[f] - med - floor);
  }

  // Peak picking: local maxima within ±~30ms
  const localR = Math.max(1, Math.round((0.03 * sampleRate) / hop));
  const peaks: { frame: number; value: number }[] = [];
  for (let f = 1; f < frames; f++) {
    const v = odf[f];
    if (v <= 0) continue;
    let isMax = true;
    for (let j = Math.max(0, f - localR); j <= Math.min(frames - 1, f + localR); j++) {
      if (odf[j] > v || (odf[j] === v && j < f)) { isMax = false; break; }
    }
    if (isMax) peaks.push({ frame: f, value: v });
  }
  if (!peaks.length) return [];
  const top = Math.max(...peaks.map((p) => p.value));

  const env = blockEnvelope(x, 16);
  return peaks.filter((p) => p.value / top >= 0.01).map((p) => ({
    // flux at frame f reflects new energy entering the last hop of the window
    pos: refineAttack(x, env, 16, p.frame * hop + n - hop, n, sampleRate),
    strength: p.value / top,
  }));
}

/** Energy of the first difference in small blocks — emphasises attacks over low, sustained tones. */
function blockEnvelope(x: Float32Array, block: number): Float32Array {
  const env = new Float32Array(Math.ceil(x.length / block));
  for (let b = 0; b < env.length; b++) {
    let e = 0;
    const end = Math.min(x.length, (b + 1) * block);
    for (let i = Math.max(1, b * block); i < end; i++) {
      const d = x[i] - x[i - 1];
      e += d * d;
    }
    env[b] = e / block;
  }
  return env;
}

/**
 * Given a rough onset position, find the block with the sharpest rise in
 * high-frequency energy relative to the few ms before it, then snap back to a
 * zero crossing so the slice starts cleanly.
 */
function refineAttack(
  x: Float32Array, env: Float32Array, block: number,
  rough: number, n: number, sampleRate: number,
): number {
  const lo = Math.max(1, Math.floor((rough - n) / block));
  const hi = Math.min(env.length - 1, Math.ceil((rough + n / 2) / block));
  const look = Math.max(2, Math.round((0.005 * sampleRate) / block));
  let eps = 0;
  for (let b = lo; b <= hi; b++) eps = Math.max(eps, env[b]);
  eps = eps * 1e-4 + 1e-12;

  let best = lo;
  let bestRise = -Infinity;
  for (let b = lo; b <= hi; b++) {
    let before = 0;
    let cnt = 0;
    for (let j = Math.max(0, b - look); j < b; j++) { before += env[j]; cnt++; }
    before = cnt ? before / cnt : 0;
    const rise = Math.log(env[b] + eps) - Math.log(before + eps);
    if (rise > bestRise) { bestRise = rise; best = b; }
  }
  let pos = best * block;

  // snap back to the nearest zero crossing within ~1.5ms
  const maxBack = Math.round(0.0015 * sampleRate);
  for (let i = pos; i > Math.max(0, pos - maxBack); i--) {
    if ((x[i - 1] <= 0 && x[i] > 0) || (x[i - 1] >= 0 && x[i] < 0) || x[i] === 0) { pos = i; break; }
  }
  return Math.max(0, pos);
}

/**
 * Choose slice points from analysed candidates.
 * sensitivity 0..1 — higher means more slices. Stronger hits win when two are
 * closer than `minGap`, and at most `maxCount` positions are returned.
 */
export function pickOnsets(
  candidates: OnsetCandidate[], sensitivity: number, minGap: number, maxCount: number,
): number[] {
  const s = Math.min(1, Math.max(0, sensitivity));
  const threshold = 0.9 * (1 - s) ** 2 + 0.002;
  const sorted = candidates.filter((c) => c.strength >= threshold).sort((a, b) => b.strength - a.strength);
  const chosen: number[] = [];
  for (const c of sorted) {
    if (chosen.length >= maxCount) break;
    if (chosen.every((p) => Math.abs(p - c.pos) >= minGap)) chosen.push(c.pos);
  }
  return chosen.sort((a, b) => a - b);
}

/** Snap a position to the nearest zero crossing within `radius` samples. */
export function snapToZeroCrossing(x: Float32Array, pos: number, radius: number): number {
  pos = Math.round(pos);
  for (let d = 0; d <= radius; d++) {
    for (const i of [pos - d, pos + d]) {
      if (i <= 0 || i >= x.length) continue;
      if ((x[i - 1] <= 0 && x[i] > 0) || (x[i - 1] >= 0 && x[i] < 0)) return i;
    }
  }
  return Math.min(Math.max(0, pos), x.length);
}
