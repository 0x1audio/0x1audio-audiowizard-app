import os
import shutil
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import soundfile

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "tests" / "_out"
sys.path.insert(0, str(ROOT))

from audio import decode, encode  # noqa: E402
from wizard import Change, detect_bpm, label, outline, process  # noqa: E402

RATE = 44100


def voice(seconds=3.0, f0=130.0):
    t = np.arange(int(RATE * seconds)) / RATE
    envelope = lambda f: np.exp(-(((f - 700) / 250) ** 2)) + 0.6 * np.exp(-(((f - 1800) / 350) ** 2))
    tone = sum(envelope(k * f0) * np.sin(2 * np.pi * k * f0 * t + k) for k in range(1, 120) if k * f0 < 16000)
    mono = (0.1 * tone).astype(np.float32)
    return np.stack([mono, mono])


def drums(bpm, seconds=40.0):
    rng = np.random.default_rng(3)
    x = np.zeros(int(RATE * (seconds + 1)), np.float32)
    period, t, beat = 60.0 / bpm, 0.21, 0
    while t < seconds:
        n = int(t * RATE)
        x[n : n + 3000] += (np.sin(2 * np.pi * 55 * np.arange(3000) / RATE) * np.exp(-np.arange(3000) / 800)).astype(np.float32)
        if beat % 2:
            x[n : n + 2000] += (rng.standard_normal(2000) * np.exp(-np.arange(2000) / 400) * 0.5).astype(np.float32)
        hat = int((t + period / 2) * RATE)
        x[hat : hat + 400] += (rng.standard_normal(400) * np.exp(-np.arange(400) / 60) * 0.15).astype(np.float32)
        t, beat = t + period, beat + 1
    return np.stack([x, x])


def measure(audio, pitch, low=200.0, high=1600.0):
    """Fundamental near ``pitch`` Hz, and the first formant peak between ``low`` and ``high``."""
    spectrum = np.abs(np.fft.rfft(audio[0, RATE // 2 : RATE // 2 + RATE] * np.hanning(RATE)))
    cepstrum = np.fft.irfft(np.log(spectrum + 1e-9))
    first, last = int(RATE / (pitch * 1.25)), int(RATE / (pitch / 1.25))
    f0 = RATE / (first + int(np.argmax(cepstrum[first:last])))
    harmonics = np.arange(1, int(5000 / f0)) * f0
    level = np.array([np.log(spectrum[int(f) - 4 : int(f) + 5].max()) for f in harmonics])
    inside = np.where((harmonics >= low) & (harmonics <= high))[0]
    i = int(inside[np.argmax(level[inside])])
    a, b, c = level[i - 1 : i + 2]
    return f0, harmonics[i] + 0.5 * (a - c) / (a - 2 * b + c) * f0


ORIGINAL_FORMANT = 703.0


class ProcessTest(unittest.TestCase):
    def test_neutral_is_a_copy(self):
        x = voice(1.0)
        y = process(x, RATE, Change())
        self.assertIsNot(x, y)
        np.testing.assert_array_equal(x, y)

    def test_original_measures_right(self):
        f0, formant = measure(voice(), 130)
        self.assertAlmostEqual(f0, 130, delta=1)
        self.assertAlmostEqual(formant, ORIGINAL_FORMANT, delta=10)

    # Rubber Band keeps formants to within about 15% on this voice, so 20% is the bar.
    def assert_change(self, change, pitch, formant):
        f0, measured = measure(process(voice(), RATE, change), pitch, formant / 1.6, formant * 1.6)
        self.assertAlmostEqual(f0, pitch, delta=2, msg=change)
        self.assertAlmostEqual(measured, formant, delta=formant * 0.2, msg=change)

    def test_pitch_keeps_formants(self):
        for steps in (-7, 7):
            self.assert_change(Change(pitch=steps), 130 * 2 ** (steps / 12), ORIGINAL_FORMANT)

    def test_formant_keeps_pitch(self):
        for steps in (-6, 6, 12):
            self.assert_change(Change(formant=steps), 130, ORIGINAL_FORMANT * 2 ** (steps / 12))

    def test_everything_at_once(self):
        x = voice()
        change = Change(pitch=-5, formant=3, tempo=0.8)
        self.assertAlmostEqual(process(x, RATE, change).shape[1] / x.shape[1], 1.25, delta=0.01)
        self.assert_change(change, 130 * 2 ** (-5 / 12), ORIGINAL_FORMANT * 2 ** (3 / 12))

    def test_tempo_changes_length(self):
        x = voice(2.0)
        self.assertAlmostEqual(process(x, RATE, Change(tempo=1.25)).shape[1] / x.shape[1], 0.8, delta=0.01)
        self.assertAlmostEqual(process(x, RATE, Change(tempo=0.5)).shape[1] / x.shape[1], 2.0, delta=0.02)

    def test_never_clips(self):
        loud = voice(1.0) * 9
        self.assertLessEqual(float(np.max(np.abs(process(loud, RATE, Change(pitch=3))))), 0.999 + 1e-6)

    def test_outline_follows_the_loud_part(self):
        audio = np.zeros((1, RATE), np.float32)
        audio[0, RATE // 2 :] = 0.5
        peaks = outline(audio, bars=10)
        self.assertEqual(len(peaks), 10)
        self.assertGreater(max(peaks[5:]), max(peaks[:5]))

    def test_fast_render_keeps_the_tempo(self):
        audio = voice(1.0)
        changed = process(audio, RATE, Change(tempo=0.5), fast=True)
        self.assertAlmostEqual(changed.shape[1] / audio.shape[1], 2.0, delta=0.05)

    def test_rejects_wild_tempo(self):
        with self.assertRaises(ValueError):
            process(voice(1.0), RATE, Change(tempo=5))


class TempoTest(unittest.TestCase):
    def test_finds_the_tempo(self):
        for bpm in (93, 100, 120, 128, 140, 150):
            self.assertEqual(detect_bpm(drums(bpm), RATE), bpm)

    def test_fast_tempos_may_read_half_time(self):
        self.assertIn(detect_bpm(drums(174), RATE), (87, 174))

    def test_no_beat(self):
        self.assertIsNone(detect_bpm(np.zeros((2, RATE * 10), np.float32), RATE))
        self.assertIsNone(detect_bpm(np.zeros((2, 100), np.float32), RATE))


class FilesTest(unittest.TestCase):
    def setUp(self):
        shutil.rmtree(OUT, ignore_errors=True)
        OUT.mkdir(parents=True)

    def test_round_trip(self):
        x = voice(1.0)
        for kind in ("wav", "aiff", "flac", "mp3"):
            written = encode(x, RATE, OUT / "tone.wav", kind)
            self.assertEqual(written.suffix, f".{kind}")
            back, info = decode(str(written))
            self.assertEqual(info.rate, RATE)
            self.assertEqual(back.shape[0], 2)
            self.assertAlmostEqual(back.shape[1] / RATE, 1.0, delta=0.08, msg=kind)

    def test_labels(self):
        self.assertEqual(label(Change(pitch=3, formant=-2, tempo=1.1), 128), "pitch +3, formant -2, 128 BPM")
        self.assertEqual(label(Change(pitch=-1.5), None), "pitch -1.5")
        self.assertEqual(label(Change(tempo=1.25), None), "125% speed")
        self.assertEqual(label(Change(), None), "copy")


class WorkerTest(unittest.TestCase):
    def setUp(self):
        shutil.rmtree(OUT, ignore_errors=True)
        OUT.mkdir(parents=True)
        os.environ["OX1_DATA"] = str(OUT / "data")
        soundfile.write(OUT / "Song.wav", drums(120, 12).T, RATE, subtype="PCM_24")

    def wait(self, worker, ident):
        for _ in range(300):
            job = worker.status(SimpleNamespace(body={"id": ident}))
            if job["done"]:
                return job
            time.sleep(0.05)
        self.fail("job never finished")

    def test_analyze_preview_export(self):
        import audiowizard as worker

        song = str(OUT / "Song.wav")
        job = self.wait(worker, worker.analyze(SimpleNamespace(body={"path": song}))["id"])
        self.assertIsNone(job["error"])
        self.assertEqual(job["result"]["bpm"], 120)
        self.assertEqual(len(job["result"]["peaks"]), 900)
        self.assertGreater(max(job["result"]["peaks"]), 0)

        body = {"path": song, "pitch": 3, "formant": -2, "source_bpm": 120, "target_bpm": 128}
        heard = self.wait(worker, worker.listen(SimpleNamespace(body=body))["id"])
        self.assertIsNone(heard["error"])
        self.assertAlmostEqual(heard["result"]["duration"], job["result"]["duration"] * 120 / 128, delta=0.15)
        self.assertEqual(len(heard["result"]["peaks"]), 900)
        self.assertTrue(Path(heard["result"]["path"]).is_relative_to(OUT / "data" / "previews"))
        preview = self.wait(worker, worker.render(SimpleNamespace(body={**body, "preview": True, "start": 2, "length": 4}))["id"])
        self.assertIsNone(preview["error"])
        self.assertTrue(Path(preview["result"]["path"]).is_relative_to(OUT / "data" / "previews"))
        self.assertAlmostEqual(preview["result"]["duration"], 4 * 120 / 128, delta=0.05)

        names = []
        for _ in range(2):
            done = self.wait(worker, worker.render(SimpleNamespace(body={**body, "format": "flac"}))["id"])
            self.assertIsNone(done["error"])
            names.append(done["result"]["name"])
        self.assertEqual(names, ["Song (pitch +3, formant -2, 128 BPM).flac", "Song (pitch +3, formant -2, 128 BPM) (1).flac"])

    def test_missing_file(self):
        import audiowizard as worker

        with self.assertRaises(ValueError):
            worker.analyze(SimpleNamespace(body={"path": str(OUT / "nope.wav")}))


if __name__ == "__main__":
    unittest.main()
