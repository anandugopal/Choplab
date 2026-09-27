import { describe, expect, it } from 'vitest';
import { makeDemoLoop } from '../src/audio/demo';
import { detectOnsetCandidates } from '../src/audio/onsets';
import { BASE_NOTE, SliceMap } from '../src/slices';

const loop = makeDemoLoop();
const candidates = detectOnsetCandidates(loop.samples, loop.sampleRate);
const make = () => {
  const m = new SliceMap('demo', loop.samples.length, loop.sampleRate);
  m.setCandidates(candidates);
  return m;
};

describe('SliceMap', () => {
  it('covers the whole sample with contiguous slices mapped from C1 upward', () => {
    const m = make();
    const s = m.slices;
    expect(s[0].start).toBe(0);
    expect(s.at(-1)!.end).toBe(loop.samples.length);
    s.forEach((x, i) => {
      expect(x.note).toBe(BASE_NOTE + i);
      if (i) expect(x.start).toBe(s[i - 1].end);
    });
  });

  it('keeps manual edits when sensitivity changes', () => {
    const m = make();
    const added = m.addMarker(1000)!;
    m.setSensitivity(0.1);
    expect(m.markers.find((x) => x.id === added.id)?.pos).toBe(1000);
    m.setSensitivity(1);
    expect(m.markers.find((x) => x.id === added.id)?.pos).toBe(1000);
  });

  it('turns a moved auto marker into a manual one and does not re-add the original', () => {
    const m = make();
    const target = m.markers[3];
    const oldPos = target.pos;
    m.moveMarker(target.id, oldPos + 2000);
    m.setSensitivity(m.sensitivity + 0.01);
    expect(m.markers.some((x) => x.pos === oldPos)).toBe(false);
    expect(m.markers.find((x) => x.id === target.id)?.source).toBe('manual');
  });

  it('does not bring back deleted slice points until edits are reset', () => {
    const m = make();
    const before = m.markers.length;
    const victim = m.markers[2];
    m.removeMarker(victim.id);
    m.setSensitivity(m.sensitivity);
    expect(m.markers.length).toBe(before - 1);
    m.resetEdits();
    expect(m.markers.length).toBe(before);
  });

  it('grid mode divides evenly', () => {
    const m = make();
    m.setMode('grid');
    m.setGridDivisions(8);
    expect(m.slices.length).toBe(8);
  });

  it('keeps markers ordered when dragged past a neighbour', () => {
    const m = make();
    const [, b, c] = m.markers;
    m.moveMarker(b.id, c.pos + 5000);
    expect(m.markers[1].pos).toBeLessThan(m.markers[2].pos);
  });
});
