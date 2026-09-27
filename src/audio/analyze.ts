import type { OnsetCandidate } from './onsets';

let worker: Worker | null = null;
let seq = 0;

/** Run onset detection off the main thread. Only the latest request resolves. */
export function analyzeOnsets(samples: Float32Array, sampleRate: number): Promise<OnsetCandidate[]> {
  worker ??= new Worker(new URL('./onsets.worker.ts', import.meta.url), { type: 'module' });
  const id = ++seq;
  const copy = samples.slice();
  return new Promise((resolve, reject) => {
    const w = worker!;
    const onMsg = (e: MessageEvent<{ id: number; candidates: OnsetCandidate[] }>) => {
      if (e.data.id !== id) return;
      w.removeEventListener('message', onMsg);
      resolve(e.data.candidates);
    };
    w.addEventListener('message', onMsg);
    w.addEventListener('error', reject, { once: true });
    w.postMessage({ id, samples: copy, sampleRate }, [copy.buffer]);
  });
}
