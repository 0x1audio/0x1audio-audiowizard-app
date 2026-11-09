"""audioWizard's actions.

The page changes pitch, formant, and tempo live in Web Audio. ``open_audio`` turns a
file into samples the page can play, and ``save`` turns the page's render back
into a file. Samples travel through the app's data folder as raw float32, one
whole channel after another, so neither side has to copy them through JSON.
The page calls both with ox.run; Mixel runs them in the background.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

import numpy as np
import ox1audio as ox

from audio import decode, encode, free_path, true_peak
from wizard import detect_bpm, label, peaks

KEEP_TRACKS = 6
FORMATS = ("wav", "aiff", "flac", "mp3")


@ox.action("Open audio", timeout=3600)
def open_audio(path: ox.Files("audio", multiple=False)):
    """Decode a file into the data folder. The result says where its samples are."""
    ox.progress(None, path.name)
    return _open(str(path.resolve()))


@ox.action("Save", timeout=3600)
def save(
    samples: str,
    rate: ox.Number(1000, 768000),
    channels: ox.Number(1, 32),
    source: ox.Files("audio", multiple=False),
    format: ox.Choice(*FORMATS) = "wav",
    output: ox.Folder() | None = None,
    pitch: float = 0.0,
    formant: float = 0.0,
    tempo: float = 1.0,
    bpm: float | None = None,
):
    """Encode samples the page rendered into ``renders/``; the file goes to the Library."""
    rendered = _data_file(samples, "renders")
    name = label(_number(pitch), _number(formant), _number(tempo, 1.0), _number(bpm) or None)
    return _save(rendered, rate, channels, str(source.resolve()), format, str(output) if output else None, name)


def _open(path: str) -> dict:
    source = Path(path)
    stamp = source.stat()
    key = hashlib.sha1(f"{path}|{stamp.st_size}|{stamp.st_mtime_ns}".encode()).hexdigest()[:20]
    folder = _data() / "tracks"
    samples, about = folder / f"{key}.f32", folder / f"{key}.json"
    if samples.is_file() and about.is_file():
        os.utime(samples)
        return json.loads(about.read_text())

    audio, info = decode(path)
    folder.mkdir(parents=True, exist_ok=True)
    partial = samples.with_suffix(".part")
    audio.tofile(partial)
    partial.replace(samples)
    result = {
        "samples": f"tracks/{samples.name}",
        "codec": info.codec,
        "rate": info.rate,
        "channels": audio.shape[0],
        "frames": audio.shape[1],
        "bpm": detect_bpm(audio, info.rate),
        "peaks": peaks(audio),
    }
    about.write_text(json.dumps(result))
    _prune(folder)
    return result


def _save(rendered: Path, rate: int, channels: int, source: str, kind: str, output: str | None, name: str) -> dict:
    try:
        audio = np.fromfile(rendered, dtype="<f4")
    finally:
        rendered.unlink(missing_ok=True)
    audio = audio[: audio.size // channels * channels].reshape(channels, -1)
    # Lossless files hold up to full scale. A lossy file's decoder overshoots between samples, so
    # MP3, AAC and Ogg get a true-peak ceiling of -1 dBTP instead (GAB-137). One gain, never a limiter.
    lossy = kind not in ("wav", "aiff", "flac")
    ceiling = 10 ** (-1 / 20) if lossy else 0.999
    peak = true_peak(audio) if lossy else (float(np.abs(audio).max()) if audio.size else 0.0)
    if peak > ceiling:
        audio *= ceiling / peak
        print(f"Lowered {20 * np.log10(peak / ceiling):.1f} dB so it doesn't clip.")
    original = Path(source)
    folder = Path(output) if output else original.parent
    target = folder / f"{original.stem} ({name}).{kind}"
    written = encode(audio, rate, free_path(target, original), kind)
    return ox.sound(written, title=written.stem)


def _prune(folder: Path) -> None:
    kept = sorted(folder.glob("*.f32"), key=lambda item: item.stat().st_mtime, reverse=True)
    for old in kept[KEEP_TRACKS:]:
        old.unlink(missing_ok=True)
        old.with_suffix(".json").unlink(missing_ok=True)


def _data() -> Path:
    # The desktop sets this. The SDK on older desktops has no ox1audio.data, so read it directly.
    value = os.environ.get("OX1_DATA", "").strip()
    if not value:
        raise RuntimeError("This app has no data folder.")
    return Path(value)


def _data_file(value, folder: str) -> Path:
    root = (_data() / folder).resolve()
    path = (_data() / str(value or "")).resolve()
    if path.parent != root or not path.is_file():
        raise ox.Problem("Those samples are gone.", hint="Export again.")
    return path


def _number(value, fallback: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return number if np.isfinite(number) else fallback

