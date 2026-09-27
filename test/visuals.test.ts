import { describe, expect, it } from 'vitest';
import { bandMean, FeatureTracker } from '../src/visuals/features';
import { hitPosition } from '../src/visuals/background';

const BIN_HZ = 48000 / 2048;

function spectrum(fill: (hz: number) => number) {
  return Uint8Array.from({ length: 1024 }, (_, i) => fill(i * BIN_HZ));
}

describe('visual features', () => {
  it('measures band energy', () => {
    const s = spectrum((hz) => (hz < 150 ? 255 : 0));
    expect(bandMean(s, BIN_HZ, 30, 140)).toBeCloseTo(1);
    expect(bandMean(s, BIN_HZ, 2000, 10000)).toBe(0);
  });

  it('stays calm in silence and reacts to a bass hit', () => {
    const t = new FeatureTracker();
    const silent = spectrum(() => 0);
    for (let i = 0; i < 60; i++) t.update(silent, BIN_HZ, 1 / 60);
    expect(t.value.bass).toBe(0);
    expect(t.value.kick).toBe(0);

    const kick = spectrum((hz) => (hz < 150 ? 200 : 10));
    const f = t.update(kick, BIN_HZ, 1 / 60);
    expect(f.kick).toBeGreaterThan(0.5);
    expect(f.bass).toBeGreaterThan(f.high);

    for (let i = 0; i < 60; i++) t.update(silent, BIN_HZ, 1 / 60);
    expect(t.value.kick).toBeLessThan(0.05);
    expect(t.value.bass).toBeLessThan(0.05);
  });

  it('normalises quiet material up to a useful range', () => {
    const t = new FeatureTracker();
    const quiet = spectrum((hz) => (hz > 2000 && hz < 10000 ? 40 : 0));
    for (let i = 0; i < 120; i++) t.update(quiet, BIN_HZ, 1 / 60);
    expect(t.value.high).toBeGreaterThan(0.9);
  });

  it('gives each slice a stable on-screen spot', () => {
    const spots = Array.from({ length: 16 }, (_, i) => hitPosition(i));
    for (const p of spots) {
      expect(p.x).toBeGreaterThanOrEqual(0.1);
      expect(p.x).toBeLessThanOrEqual(0.9);
    }
    expect(hitPosition(3)).toEqual(spots[3]);
    expect(new Set(spots.map((p) => p.x.toFixed(3))).size).toBe(16);
  });
});
