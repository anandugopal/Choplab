import { describe, expect, it } from 'vitest';
import { makeDemoLoop } from '../src/audio/demo';
import { detectOnsetCandidates, pickOnsets } from '../src/audio/onsets';

const loop = makeDemoLoop();
const candidates = detectOnsetCandidates(loop.samples, loop.sampleRate);
const minGap = Math.round(0.03 * loop.sampleRate);
const tol = 0.002 * loop.sampleRate;
const near = (a: number, list: number[]) => list.some((b) => Math.abs(a - b) <= tol);

describe('onset detection', () => {
  it('finds every hit after the downbeat within 2ms at full sensitivity', () => {
    const picked = pickOnsets(candidates, 1, minGap, 64);
    const missed = loop.hits.filter((h) => h > 0 && !near(h, picked));
    expect(missed).toEqual([]);
    expect(picked.filter((p) => !near(p, loop.hits))).toEqual([]);
  });

  it('returns fewer slices at lower sensitivity, strongest first', () => {
    const counts = [0, 0.25, 0.5, 1].map((s) => pickOnsets(candidates, s, minGap, 64).length);
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
    expect(counts[0]).toBeLessThan(counts[3]);
  });

  it('respects the slice cap and minimum gap', () => {
    const picked = pickOnsets(candidates, 1, minGap, 5);
    expect(picked.length).toBe(5);
    for (let i = 1; i < picked.length; i++) expect(picked[i] - picked[i - 1]).toBeGreaterThanOrEqual(minGap);
  });
});
