import { STEPS_PER_BEAT, type Note, type Pattern } from './pattern';

export interface Clock {
  readonly currentTime: number;
}

/** Called for every note that should sound, ahead of time. */
export type ScheduleFn = (note: Note, time: number, duration: number) => void;

const LOOKAHEAD = 0.12; // seconds of audio scheduled ahead
const INTERVAL = 25; // ms between scheduler ticks

/**
 * Look-ahead scheduler: a timer wakes every 25ms and books every note due in
 * the next 120ms on the AudioContext clock, so timing stays sample-accurate
 * even when the main thread is busy.
 *
 * Swing works like an MPC: 50% is straight, 66% puts every second 16th on the
 * triplet, 75% is a dotted feel.
 */
export class Sequencer extends EventTarget {
  bpm = 120;
  swing = 0.5;
  playing = false;

  private nextStep = 0;
  private nextTime = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private booked: { step: number; time: number }[] = [];

  private clock: Clock;
  private pattern: Pattern;
  private schedule: ScheduleFn;

  constructor(clock: Clock, pattern: Pattern, schedule: ScheduleFn) {
    super();
    this.clock = clock;
    this.pattern = pattern;
    this.schedule = schedule;
  }

  get stepDuration() {
    return 60 / this.bpm / STEPS_PER_BEAT;
  }

  start(autoTick = true) {
    if (this.playing) return;
    this.playing = true;
    this.nextStep = 0;
    this.nextTime = this.clock.currentTime + 0.05;
    this.booked = [];
    this.tick();
    if (autoTick) this.timer = setInterval(() => this.tick(), INTERVAL);
    this.dispatchEvent(new Event('state'));
  }

  stop() {
    if (!this.playing) return;
    this.playing = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.booked = [];
    this.dispatchEvent(new Event('state'));
  }

  toggle() {
    if (this.playing) this.stop();
    else this.start();
  }

  /** Book everything due before now + lookahead. Public so tests can drive it. */
  tick() {
    const until = this.clock.currentTime + LOOKAHEAD;
    const steps = this.pattern.steps;
    while (this.nextTime < until) {
      const step = this.nextStep % steps;
      const dur = this.stepDuration;
      const offset = step % 2 ? (this.swing - 0.5) * 2 * dur : 0;
      const t = this.nextTime + offset;
      for (const n of this.pattern.notesAt(step)) this.schedule(n, t, n.length * dur);
      this.booked.push({ step, time: t });
      this.nextStep = (step + 1) % steps;
      this.nextTime += dur;
    }
    const now = this.clock.currentTime;
    while (this.booked.length > 2 && this.booked[1].time <= now) this.booked.shift();
  }

  /** Current position in steps (fractional), or -1 when stopped. */
  position(): number {
    if (!this.playing) return -1;
    const now = this.clock.currentTime;
    let i = -1;
    while (i + 1 < this.booked.length && this.booked[i + 1].time <= now) i++;
    if (i < 0) return -1;
    const a = this.booked[i];
    const b = this.booked[i + 1];
    const dur = b ? b.time - a.time : this.stepDuration;
    return a.step + Math.min(1, (now - a.time) / dur);
  }
}
