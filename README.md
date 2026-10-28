# audioWizard

An official 0x1audio app. Drop in audio and change its pitch, formant, and tempo, each on its own.

- **Pitch** moves the notes up or down by up to 24 semitones and keeps the voice's character.
- **Formant** moves the character of a voice (bigger or smaller, darker or brighter) by up to 12 semitones without moving the notes.
- **BPM** is detected for you. Set a new BPM and the track speeds up or slows down without changing pitch. If the detector picks half or double time, use ½× or 2×.

The waveform is the player, and every change is heard right away while it plays. Export to WAV, AIFF, FLAC, or MP3. Exports are named after the change, like `Song (pitch +3, formant -2, 128 BPM).wav`.

## How it works

Pitch, formant, and tempo all run through [Signalsmith Stretch](https://signalsmith-audio.co.uk/code/stretch/) in an AudioWorklet: live while you listen, and offline in an `OfflineAudioContext` for export, so the file sounds like what you heard.

The Python worker does the file work. It decodes each file once with ffmpeg into raw float32 in the app's data folder (kept for the last few files, so reopening is instant), finds the tempo and the waveform, and later encodes the page's render into the chosen format. Samples move between the page and the worker through the data folder, never through JSON.

## Develop

```sh
pnpm install
pnpm build
uv run --group dev python -m unittest discover tests
```

The page is `src/` (`engine.ts` is the audio, `bridge.ts` talks to the worker), the worker is `audiowizard.py`, file reading and writing is `audio.py`, and tempo and waveform detection is `wizard.py`.
