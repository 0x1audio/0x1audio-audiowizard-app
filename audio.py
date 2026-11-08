"""Files in and out, through ox.audio: no programs of our own to run.

decode() gives samples shaped (channels, frames), which is how the page and wizard.py
work; encode() writes them as WAV, AIFF or FLAC (24-bit) or MP3 (320 kb/s).
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import ox1audio as ox

FORMATS = ("wav", "aiff", "flac", "mp3")


def decode(path: str):
    """Decode the first audio stream to float32, shaped (channels, frames). Also returns ox.audio.probe's info."""
    info = ox.audio.probe(path)
    samples, _rate = ox.audio.read(path)
    return np.ascontiguousarray(samples.T), info


def encode(audio: np.ndarray, rate: int, target: Path, kind: str = "wav") -> Path:
    """Write float32 audio shaped (channels, frames) as ``target`` with the format's extension."""
    kind = kind if kind in FORMATS else "wav"
    stem = target.stem if target.suffix.lower() in {f".{item}" for item in FORMATS} or target.suffix == ".aif" else target.name
    return ox.audio.write(np.asarray(audio, dtype="float32").T, rate, kind, folder=target.parent, name=stem)


def free_path(target: Path, avoid: Path | None = None) -> Path:
    """``target``, or ``target (1)``, ``target (2)``… so nothing is overwritten."""
    candidate = target
    index = 1
    while candidate.exists() or (avoid is not None and candidate.resolve() == avoid.resolve()):
        candidate = target.with_name(f"{target.stem} ({index}){target.suffix}")
        index += 1
    return candidate
