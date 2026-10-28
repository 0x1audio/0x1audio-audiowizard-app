# audioWizard

An official 0x1audio app. Drop in audio and change its pitch, formant, and tempo, each on its own.

- **Pitch** moves the notes up or down by up to 24 semitones and keeps the voice's character.
- **Formant** moves the character of a voice (bigger or smaller, darker or brighter) by up to 12 semitones without moving the notes.
- **BPM** is detected for you. Set a new BPM and the track speeds up or slows down without changing pitch. If the detector picks half or double time, use ½× or 2×.
- **Character** picks how attacks are treated: Crisp for drums, Smooth for vocals and pads, Mixed in between.

Preview 30 seconds from wherever the original player is, then export to WAV, AIFF, FLAC, or MP3. Exports are named after the change, like `Song (pitch +3, formant -2, 128 BPM).wav`.

Pitch and tempo use [Rubber Band](https://breakfastquay.com/rubberband/) through Spotify's `pedalboard`. The formant is moved by resampling first and then letting Rubber Band restore pitch and speed while it keeps the new formants.

## Develop

```sh
pnpm install
pnpm build
uv run --group dev python -m unittest discover tests
```

The page is `src/`, the worker is `audiowizard.py`, and the audio work is `wizard.py`.
