# Choplab

A browser sampler. Drop in a sound, get it sliced on its transients like Ableton's Slice to MIDI, tweak the slice points, and play slices from pads or the keyboard.

```sh
npm install
npm run dev     # http://localhost:5173
npm test        # onset detection + slice model tests
npm run build
```

## Using it

- **Load**: drop an audio file anywhere on the page, use *Open*, or try *Demo*.
- **Slice by**: *Transient* (with a sensitivity control), *Grid* (equal divisions) or *Manual*.
- **Edit**: double-click the waveform to add a slice point, drag a marker (or its numbered flag) to move it, right-click to delete. Markers snap to zero crossings; hold Alt while dragging to turn that off. Edited markers turn amber and survive sensitivity changes; *Reset edits* clears them.
- **Play**: click a slice or a pad. Keys `zxcv`/`asdf`/`qwer`/`1234` are the pad grid from the bottom row up, `[` `]` switch banks of 16, arrows step through slices, Shift+Space plays the whole sample.
- **Sequence**: short loops are laid out as a pattern automatically (tempo guessed from the loop length, one note per slice, like Slice to MIDI). Space plays the pattern. In the piano roll, click to add a note and drag right to lengthen it, click a note to delete it, drag to move it, drag its end to resize. Drag in the velocity lane to set velocities. Tempo, MPC-style swing (50–75%) and loop length (1–8 bars) are in the transport. Turn on Rec (Shift+R) to write pad hits into the pattern while it plays.
- **Visuals**: an audio-reactive WebGL background follows the master output. Bass swells a glow from the bottom, mids stir the flow, highs sparkle, and every slice hit sends out a ring in that slice's colour at the moment it's heard. Toggle with the star button or Shift+V (off by default if the system asks for reduced motion).
- **Navigate**: scroll to zoom, Shift+scroll or trackpad swipe to pan, or drag in the overview strip.
- **Layout**: transport (play, rec, tempo, swing, length) lives in the top bar; the slicer, pads and piano roll fit on one screen on desktop and stack on phones. Press `?` for every key and mouse gesture.

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

`playSlice` takes an `AudioContext` time so notes can be scheduled ahead with sample accuracy. Retriggering a slice chokes its previous voice; the *Choke* toggle on the pads makes every slice choke every other. *Export slices* downloads the map as JSON (`SliceMapJSON`).

## Sequencer

`src/sequencer/pattern.ts` holds a `Pattern` of notes on a 16th-note grid (`step`, `length`, `note`, `velocity`). Notes address slices by MIDI note, so re-slicing changes what a note plays rather than where it sits. `src/sequencer/sequencer.ts` is a look-ahead scheduler: every 25ms it books the next 120ms of notes on the AudioContext clock through `engine.playSlice`, so timing stays sample-accurate even when the UI is busy.
