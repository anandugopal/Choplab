import { describe, expect, it } from 'vitest';
import { makeDemoLoop } from '../src/audio/demo';
import { detectOnsetCandidates } from '../src/audio/onsets';
import { estimateLoop, Pattern } from '../src/sequencer/pattern';
import { Sequencer } from '../src/sequencer/sequencer';
import { BASE_NOTE, SliceMap } from '../src/slices';

function run(seq: Sequencer, clock: { currentTime: number }, seconds: number) {
  seq.start(false);
  for (let t = 0; t < seconds; t += 0.025) {
    clock.currentTime = t;
    seq.tick();
  }
}

describe('estimateLoop', () => {
  it('reads a 5s loop as 2 bars at 96 bpm', () => {
    expect(estimateLoop(5)).toEqual({ bpm: 96, bars: 2 });
  });
  it('rejects long songs', () => {
    expect(estimateLoop(180)).toBeNull();
  });
});

describe('Pattern.fillFromSlices', () => {
  it('places one note per slice at its original 16th, held to the next note', () => {
    const loop = makeDemoLoop();
    const map = new SliceMap('demo', loop.samples.length, loop.sampleRate);
    map.setCandidates(detectOnsetCandidates(loop.samples, loop.sampleRate));
    map.setSensitivity(1);
    const p = new Pattern();
    p.fillFromSlices(map.slices, loop.sampleRate, loop.bpm);
    expect(p.notes.map((n) => n.step)).toEqual([0, 2, 4, 6, 7, 8, 10, 12, 14, 16, 18, 20, 22, 24, 25, 26, 28, 30, 31]);
    expect(p.notes.map((n) => n.note)).toEqual(map.slices.map((s) => s.note));
    expect(p.notes[0].length).toBe(2);
    expect(p.notes.at(-1)!.length).toBe(1);
  });
});

describe('Sequencer', () => {
  it('schedules notes on the grid and loops', () => {
    const clock = { currentTime: 0 };
    const p = new Pattern();
    p.setBars(1);
    p.add({ step: 0, length: 2, note: BASE_NOTE, velocity: 1 });
    p.add({ step: 4, length: 1, note: BASE_NOTE + 1, velocity: 1 });
    const hits: [number, number, number][] = [];
    const seq = new Sequencer(clock, p, (n, t, d) => hits.push([n.note, t, d]));
    seq.bpm = 120; // 16th = 0.125s, bar = 2s
    run(seq, clock, 4.5);
    const times = hits.map(([, t]) => +(t - 0.05).toFixed(4));
    expect(times).toEqual([0, 0.5, 2, 2.5, 4, 4.5]);
    expect(hits[0][2]).toBeCloseTo(0.25);
  });

  it('delays every second 16th by the swing amount', () => {
    const clock = { currentTime: 0 };
    const p = new Pattern();
    p.setBars(1);
    p.add({ step: 0, length: 1, note: BASE_NOTE, velocity: 1 });
    p.add({ step: 1, length: 1, note: BASE_NOTE, velocity: 1 });
    const times: number[] = [];
    const seq = new Sequencer(clock, p, (_n, t) => times.push(t));
    seq.bpm = 120;
    seq.swing = 0.66;
    run(seq, clock, 0.5);
    expect(times[1] - times[0]).toBeCloseTo(0.125 + 0.16 * 2 * 0.125);
  });

  it('reports playhead position in steps', () => {
    const clock = { currentTime: 0 };
    const p = new Pattern();
    const seq = new Sequencer(clock, p, () => {});
    seq.bpm = 120;
    run(seq, clock, 1);
    clock.currentTime = 0.05 + 0.125 * 8.5;
    expect(seq.position()).toBeCloseTo(8.5);
  });
});
