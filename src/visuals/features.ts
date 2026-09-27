/**
 * Turns an AnalyserNode's spectrum into a handful of smooth 0..1 controls for
 * the background visuals: band levels, overall level, and a "kick" pulse that
 * jumps on low-end onsets and decays.
 *
 * Levels are normalised against a slowly falling running peak (a simple AGC),
 * so a quiet sample moves the visuals as much as a loud one.
 */

export interface Features {
  bass: number;
  mid: number;
  high: number;
  level: number;
  kick: number;
}

const BANDS = { bass: [30, 150], mid: [150, 2000], high: [2000, 10000] } as const;
const PEAK_FALL = 0.1; // per second, fraction of the running peak lost
const PEAK_FLOOR = 0.08; // don't amplify silence into noise
const ATTACK = 0.5; // seconds-independent smoothing weights, per 60fps frame
const RELEASE = 0.12;
const KICK_DECAY = 5; // per second

export class FeatureTracker {
  readonly value: Features = { bass: 0, mid: 0, high: 0, level: 0, kick: 0 };
  private peak = { bass: PEAK_FLOOR, mid: PEAK_FLOOR, high: PEAK_FLOOR };
  private prevBass = 0;
  private bassAvg = 0;

  /**
   * @param spectrum byte magnitudes from `getByteFrequencyData`
   * @param binHz sampleRate / fftSize
   * @param dt seconds since the last update
   */
  update(spectrum: Uint8Array, binHz: number, dt: number): Features {
    dt = Math.min(Math.max(dt, 0), 0.1);
    const frames = dt * 60;
    const v = this.value;

    for (const band of ['bass', 'mid', 'high'] as const) {
      const [lo, hi] = BANDS[band];
      const raw = bandMean(spectrum, binHz, lo, hi);
      this.peak[band] = Math.max(raw, PEAK_FLOOR, this.peak[band] * (1 - PEAK_FALL * dt));
      const target = (raw / this.peak[band]) ** 2; // squared for contrast
      const k = target > v[band] ? ATTACK : RELEASE;
      v[band] += (target - v[band]) * (1 - Math.pow(1 - k, frames));
    }
    v.level = Math.min(1, 0.5 * v.bass + 0.3 * v.mid + 0.2 * v.high);

    // Low-end onset: bass rising well above its recent average.
    const bass = bandMean(spectrum, binHz, BANDS.bass[0], BANDS.bass[1]);
    const rise = bass - this.prevBass;
    this.bassAvg += (bass - this.bassAvg) * Math.min(1, dt * 4);
    this.prevBass = bass;
    v.kick *= Math.exp(-KICK_DECAY * dt);
    if (rise > 0.06 && bass > this.bassAvg * 1.15) v.kick = Math.max(v.kick, Math.min(1, rise * 6));
    return v;
  }

  /** Add an external hit (e.g. a slice trigger) to the kick pulse. */
  bump(amount: number) {
    this.value.kick = Math.max(this.value.kick, Math.min(1, amount));
  }
}

/** Mean magnitude (0..1) of the bins between lo and hi Hz. */
export function bandMean(spectrum: Uint8Array, binHz: number, lo: number, hi: number): number {
  const a = Math.max(1, Math.floor(lo / binHz));
  const b = Math.min(spectrum.length - 1, Math.ceil(hi / binHz));
  if (b < a) return 0;
  let sum = 0;
  for (let i = a; i <= b; i++) sum += spectrum[i];
  return sum / (b - a + 1) / 255;
}
