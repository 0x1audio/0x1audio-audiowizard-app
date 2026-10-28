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
from wizard import detect_bpm, label, peaks  # noqa: E402

RATE = 44100


def tone(seconds=1.0):
    t = np.arange(int(RATE * seconds)) / RATE
    mono = (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
    return np.stack([mono, mono])


def drums(bpm, seconds=40.0, rate=RATE):
    rng = np.random.default_rng(3)
    x = np.zeros(int(rate * (seconds + 1)), np.float32)
    period, t, beat = 60.0 / bpm, 0.21, 0
    kick = (np.sin(2 * np.pi * 55 * np.arange(3000) / rate) * np.exp(-np.arange(3000) / 800)).astype(np.float32)
    while t < seconds:
        n = int(t * rate)
        x[n : n + 3000] += kick
        if beat % 2:
            x[n : n + 2000] += (rng.standard_normal(2000) * np.exp(-np.arange(2000) / 400) * 0.5).astype(np.float32)
        hat = int((t + period / 2) * rate)
        x[hat : hat + 400] += (rng.standard_normal(400) * np.exp(-np.arange(400) / 60) * 0.15).astype(np.float32)
        t, beat = t + period, beat + 1
    return np.stack([x, x])


class PeaksTest(unittest.TestCase):
    def test_follows_the_loud_part(self):
        audio = np.zeros((2, RATE), np.float32)
        audio[1, RATE // 2 :] = -0.5
        found = peaks(audio, bars=10)
        self.assertEqual(found, [0.0] * 5 + [0.5] * 5)

    def test_short_and_empty(self):
        self.assertEqual(len(peaks(np.ones((1, 3), np.float32))), 3)
        self.assertEqual(peaks(np.zeros((2, 0), np.float32)), [])


class TempoTest(unittest.TestCase):
    def test_finds_the_tempo(self):
        for bpm in (93, 100, 120, 128, 140, 150):
            self.assertEqual(detect_bpm(drums(bpm), RATE), bpm)

    def test_other_rates(self):
        self.assertEqual(detect_bpm(drums(128, rate=48000), 48000), 128)
        self.assertEqual(detect_bpm(drums(128, 20, rate=96000), 96000), 128)

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
        x = tone()
        for kind in ("wav", "aiff", "flac", "mp3"):
            written = encode(x, RATE, OUT / "tone.wav", kind)
            self.assertEqual(written.suffix, f".{kind}")
            back, info = decode(str(written))
            self.assertEqual(info.rate, RATE)
            self.assertEqual(back.shape[0], 2)
            self.assertAlmostEqual(back.shape[1] / RATE, 1.0, delta=0.08, msg=kind)

    def test_keeps_dots_in_names(self):
        self.assertEqual(encode(tone(0.1), RATE, OUT / "Song (pitch +1.5).flac", "flac").name, "Song (pitch +1.5).flac")

    def test_labels(self):
        self.assertEqual(label(3, -2, 1.1, 128), "pitch +3, formant -2, 128 BPM")
        self.assertEqual(label(-1.5, 0, 1, None), "pitch -1.5")
        self.assertEqual(label(0, 0, 1.25, None), "125% speed")
        self.assertEqual(label(0, 0, 1, None), "copy")


class WorkerTest(unittest.TestCase):
    def setUp(self):
        shutil.rmtree(OUT, ignore_errors=True)
        OUT.mkdir(parents=True)
        os.environ["OX1_DATA"] = str(OUT / "data")
        soundfile.write(OUT / "Song.wav", drums(120, 12).T, RATE, subtype="PCM_24")

    def call(self, handler, **body):
        return handler(SimpleNamespace(body=body))

    def wait(self, worker, job):
        for _ in range(300):
            state = self.call(worker.status, id=job["id"])
            if state["done"]:
                self.assertIsNone(state["error"])
                return state["result"]
            time.sleep(0.02)
        self.fail("job never finished")

    def test_open_then_save(self):
        import audiowizard as worker

        song = str(OUT / "Song.wav")
        track = self.wait(worker, self.call(worker.open_track, path=song))
        self.assertEqual(track["bpm"], 120)
        self.assertEqual((track["rate"], track["channels"]), (RATE, 2))
        self.assertEqual(len(track["peaks"]), 1000)
        samples = np.fromfile(OUT / "data" / track["samples"], dtype="<f4").reshape(2, -1)
        self.assertEqual(samples.shape[1], track["frames"])
        original, _ = decode(song)
        np.testing.assert_allclose(samples, original, atol=1e-6)

        started = time.monotonic()
        self.assertEqual(self.wait(worker, self.call(worker.open_track, path=song)), track)
        self.assertLess(time.monotonic() - started, 0.5)

        names = []
        for _ in range(2):
            rendered = OUT / "data" / "renders" / "next.f32"
            rendered.parent.mkdir(parents=True, exist_ok=True)
            (samples[:, ::2] * 3).tofile(rendered)
            body = {"samples": "renders/next.f32", "rate": RATE, "channels": 2, "source": song, "format": "flac"}
            saved = self.wait(worker, self.call(worker.save, **body, pitch=3, formant=-2, tempo=128 / 120, bpm=128))
            self.assertFalse(rendered.exists())
            names.append(saved["name"])
            back, _ = decode(saved["path"])
            self.assertAlmostEqual(back.shape[1], samples.shape[1] / 2, delta=2)
            self.assertLessEqual(float(np.abs(back).max()), 1.0)
        self.assertEqual(names, ["Song (pitch +3, formant -2, 128 BPM).flac", "Song (pitch +3, formant -2, 128 BPM) (1).flac"])

    def test_refuses_files_outside_renders(self):
        import audiowizard as worker

        with self.assertRaises(ValueError):
            self.call(worker.save, samples="../Song.wav", rate=RATE, channels=2, source=str(OUT / "Song.wav"))

    def test_missing_file(self):
        import audiowizard as worker

        with self.assertRaises(ValueError):
            self.call(worker.open_track, path=str(OUT / "nope.wav"))


if __name__ == "__main__":
    unittest.main()
