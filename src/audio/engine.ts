/**
 * Plays slices of the loaded sample. The sequencer can call `playSlice` with a
 * future AudioContext time for sample-accurate scheduling; the master output
 * runs through an AnalyserNode that the visuals can read later.
 */

export interface SliceRange {
  index: number;
  start: number; // sample frame
  end: number; // sample frame
}

export interface PlayOptions {
  time?: number; // AudioContext time; defaults to now
  velocity?: number; // 0..1
  duration?: number; // seconds; defaults to the full slice (one-shot)
}

export interface Voice {
  sliceIndex: number; // -1 for whole-sample preview
  startTime: number; // AudioContext time the voice begins
  startFrame: number;
  endFrame: number;
  stop(time?: number): void;
}

export interface TriggerEvent {
  sliceIndex: number;
  time: number;
  velocity: number;
}

const FADE_IN = 0.002;
const FADE_OUT = 0.006;

export class SamplerEngine {
  readonly ctx = new AudioContext({ latencyHint: 'interactive' });
  readonly output = this.ctx.createGain();
  readonly analyser = this.ctx.createAnalyser();
  buffer: AudioBuffer | null = null;
  /** When true, a new slice cuts off whatever else is playing (Simpler's mono mode). */
  mono = false;

  private voices = new Set<Voice>();
  private listeners = new Set<(e: TriggerEvent) => void>();

  constructor() {
    this.analyser.fftSize = 2048;
    this.output.gain.value = 0.9;
    this.output.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
  }

  get activeVoices(): ReadonlySet<Voice> {
    const now = this.ctx.currentTime;
    for (const v of this.voices) {
      const len = (v.endFrame - v.startFrame) / (this.buffer?.sampleRate ?? 44100);
      if (now > v.startTime + len + FADE_OUT) this.voices.delete(v);
    }
    return this.voices;
  }

  async decode(data: ArrayBuffer): Promise<AudioBuffer> {
    return this.ctx.decodeAudioData(data);
  }

  setBuffer(buffer: AudioBuffer) {
    this.stopAll();
    this.buffer = buffer;
  }

  onTrigger(fn: (e: TriggerEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  playSlice(slice: SliceRange, opts: PlayOptions = {}): Voice | null {
    // Retriggering a slice chokes its previous voice, like a pad in Simpler.
    for (const v of this.voices) {
      if (this.mono || v.sliceIndex === slice.index) v.stop(opts.time);
    }
    const voice = this.play(slice.start, slice.end, slice.index, opts);
    if (voice) {
      const e = { sliceIndex: slice.index, time: voice.startTime, velocity: opts.velocity ?? 1 };
      for (const fn of this.listeners) fn(e);
    }
    return voice;
  }

  /** Preview a range of the sample (e.g. the whole file). */
  preview(start: number, end: number): Voice | null {
    this.stopAll();
    return this.play(start, end, -1, {});
  }

  stopAll() {
    for (const v of this.voices) v.stop();
    this.voices.clear();
  }

  private play(start: number, end: number, sliceIndex: number, opts: PlayOptions): Voice | null {
    const buf = this.buffer;
    if (!buf || end <= start) return null;
    if (this.ctx.state !== 'running') void this.ctx.resume();

    const sr = buf.sampleRate;
    const t = Math.max(this.ctx.currentTime, opts.time ?? 0);
    const sliceLen = (end - start) / sr;
    const len = Math.min(sliceLen, opts.duration ?? sliceLen);
    const vel = opts.velocity ?? 1;

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(vel, t + FADE_IN);
    env.gain.setValueAtTime(vel, t + Math.max(FADE_IN, len - FADE_OUT));
    env.gain.linearRampToValueAtTime(0, t + len);
    src.connect(env).connect(this.output);
    src.start(t, start / sr, len + 0.01);

    let stopped = false;
    const voice: Voice = {
      sliceIndex,
      startTime: t,
      startFrame: start,
      endFrame: start + Math.round(len * sr),
      stop: (at?: number) => {
        if (stopped) return;
        stopped = true;
        const when = Math.max(this.ctx.currentTime, at ?? 0);
        env.gain.cancelScheduledValues(when);
        env.gain.setValueAtTime(env.gain.value, when);
        env.gain.linearRampToValueAtTime(0, when + FADE_OUT);
        src.stop(when + FADE_OUT + 0.005);
        this.voices.delete(voice);
      },
    };
    src.onended = () => this.voices.delete(voice);
    this.voices.add(voice);
    return voice;
  }
}
