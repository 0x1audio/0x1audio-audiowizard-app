"""Read and write audio with the ffmpeg that ships in the imageio-ffmpeg wheel."""

from __future__ import annotations

import functools
import os
import re
import stat
import subprocess
from dataclasses import dataclass
from pathlib import Path

import numpy as np

_stream = re.compile(r"Stream #\d+:\d+[^:]*: Audio: ([^,\n]+), (\d+) Hz, ([^,\n]+)")
_layouts = {"mono": 1, "stereo": 2, "2.1": 3, "3.0": 3, "quad": 4, "4.0": 4, "5.0": 5, "5.1": 6, "6.1": 7, "7.1": 8}


@dataclass(frozen=True)
class Info:
    path: str
    codec: str
    rate: int
    channels: int


@functools.cache
def ffmpeg() -> str:
    import imageio_ffmpeg

    exe = imageio_ffmpeg.get_ffmpeg_exe()
    mode = os.stat(exe).st_mode
    if not mode & stat.S_IXUSR:
        os.chmod(exe, mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return exe


def probe(path: str) -> Info:
    source = Path(path)
    result = subprocess.run(
        [ffmpeg(), "-hide_banner", "-nostdin", "-i", str(source)],
        capture_output=True,
        text=True,
        errors="replace",
        timeout=60,
    )
    stream = _stream.search(result.stderr)
    if not stream:
        raise ValueError(f"{source.name} has no audio ffmpeg can read.")
    return Info(
        path=str(source),
        codec=stream.group(1).split(" ")[0],
        rate=int(stream.group(2)),
        channels=channel_count(stream.group(3)),
    )


def channel_count(layout: str) -> int:
    layout = layout.strip()
    counted = re.match(r"(\d+) channels", layout)
    if counted:
        return int(counted.group(1))
    return _layouts.get(layout.split("(")[0], 2)


def decode(path: str) -> tuple[np.ndarray, Info]:
    """Decode the first audio stream to float32, shaped (channels, frames)."""
    info = probe(path)
    result = subprocess.run(
        [
            ffmpeg(), "-hide_banner", "-nostdin", "-v", "error",
            "-i", info.path, "-map", "0:a:0", "-vn",
            "-f", "f32le", "-acodec", "pcm_f32le",
            "-ac", str(info.channels), "-ar", str(info.rate),
            "pipe:1",
        ],
        capture_output=True,
        timeout=600,
    )
    if result.returncode != 0:
        tail = result.stderr.decode("utf-8", "replace").strip().splitlines()[-1:]
        raise RuntimeError(tail[0] if tail else f"Could not decode {Path(path).name}.")
    samples = np.frombuffer(result.stdout, dtype="<f4")
    frames = samples.size // info.channels
    return samples[: frames * info.channels].reshape(frames, info.channels).T.copy(), info


ENCODINGS = {
    "wav": ("wav", ["-c:a", "pcm_s24le"]),
    "aiff": ("aiff", ["-c:a", "pcm_s24be"]),
    "flac": ("flac", ["-c:a", "flac", "-sample_fmt", "s32", "-bits_per_raw_sample", "24"]),
    "mp3": ("mp3", ["-c:a", "libmp3lame", "-b:a", "320k"]),
}


def encode(audio: np.ndarray, rate: int, target: Path, kind: str = "wav") -> Path:
    """Write float32 audio shaped (channels, frames). ``target`` gets the format's extension."""
    ext, codec = ENCODINGS.get(kind, ENCODINGS["wav"])
    target = target.with_name(f"{target.stem}.{ext}") if target.suffix != f".{ext}" else target
    target.parent.mkdir(parents=True, exist_ok=True)
    if kind == "mp3" and audio.shape[0] > 2:
        audio = audio[:2]
    result = subprocess.run(
        [
            ffmpeg(), "-hide_banner", "-nostdin", "-v", "error", "-y",
            "-f", "f32le", "-ar", str(rate), "-ac", str(audio.shape[0]), "-i", "pipe:0",
            *codec, "-f", ext, str(target),
        ],
        input=np.ascontiguousarray(audio.T, dtype="<f4").tobytes(),
        capture_output=True,
        timeout=600,
    )
    if result.returncode != 0:
        target.unlink(missing_ok=True)
        tail = result.stderr.decode("utf-8", "replace").strip().splitlines()[-1:]
        raise RuntimeError(tail[0] if tail else "Could not write the audio.")
    return target


def free_path(target: Path, avoid: Path | None = None) -> Path:
    """``target``, or ``target (1)``, ``target (2)``… so nothing is overwritten."""
    candidate = target
    index = 1
    while candidate.exists() or (avoid is not None and candidate.resolve() == avoid.resolve()):
        candidate = target.with_name(f"{target.stem} ({index}){target.suffix}")
        index += 1
    return candidate
