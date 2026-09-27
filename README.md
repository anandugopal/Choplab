# Choplab

A browser sampler. Drop in a sound, get it sliced on its transients like Ableton's Slice to MIDI, tweak the slice points, and play slices from pads or the keyboard.

```sh
npm install
npm run dev     # http://localhost:5173
npm test        # onset detection + slice model tests
npm run build
```

## Using it

- **Load**: drop an audio file anywhere on the page, use *Load sample*, or try *Demo loop*.
- **Slice by**: *Transient* (with a sensitivity control), *Grid* (equal divisions) or *Manual*.
- **Edit**: double-click the waveform to add a slice point, drag a marker (or its numbered flag) to move it, right-click to delete. Markers snap to zero crossings; hold Alt while dragging to turn that off. Edited markers turn amber and survive sensitivity changes; *Reset edits* clears them.
- **Play**: click a slice or a pad. Keys `zxcv`/`asdf`/`qwer`/`1234` are the pad grid from the bottom row up, `[` `]` switch banks of 16, arrows step through slices, Space plays the whole sample.
- **Navigate**: scroll to zoom, Shift+scroll or trackpad swipe to pan, or drag in the overview strip.

## How the slicing works

`src/audio/onsets.ts` computes a log-magnitude spectral flux (≈23ms window, 75% overlap), subtracts a moving median (±100ms) to get an adaptive onset function, and picks local peaks. Each peak is then pulled back to the real start of the attack by finding the sharpest rise in high-frequency energy nearby and snapping to a zero crossing. Analysis runs once in a Web Worker; the sensitivity slider just re-filters the candidates by strength, so it responds instantly. At most 64 slices are kept (strongest first), with a 30ms minimum gap.

## Slice model (for the sequencer)

`src/slices.ts` holds a `SliceMap`: an ordered list of markers, where slice *i* runs from marker *i* to marker *i+1*. As in Ableton, slice *i* is MIDI note `36 + i` (C1 upward), so the sequencer should address slices by note or index rather than by time. `SliceMap` fires `change` whenever slices move.

```ts
const slice = map.sliceForNote(38);                 // D1 → third slice
engine.playSlice(slice, { time: ctx.currentTime + 0.1, velocity: 0.8, duration: 0.25 });
engine.onTrigger(({ sliceIndex, time, velocity }) => { /* visuals, MIDI out… */ });
engine.analyser;                                    // master AnalyserNode for visuals
```

`playSlice` takes an `AudioContext` time so notes can be scheduled ahead with sample accuracy. Retriggering a slice chokes its previous voice; the *Mono* toggle makes every slice choke every other. *Export slices* downloads the map as JSON (`SliceMapJSON`).
