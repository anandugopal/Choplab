import { detectOnsetCandidates } from './onsets';

self.onmessage = (e: MessageEvent<{ id: number; samples: Float32Array; sampleRate: number }>) => {
  const { id, samples, sampleRate } = e.data;
  postMessage({ id, candidates: detectOnsetCandidates(samples, sampleRate) });
};
