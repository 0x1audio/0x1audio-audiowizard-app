"""audioWizard worker.

The page changes pitch, formant, and tempo live in Web Audio. The worker turns
files into samples the page can play, and the page's renders back into files.
Samples travel through the app's data folder as raw float32, one whole channel
after another, so neither side has to copy them through JSON.

``open`` and ``save`` are jobs the page polls, because a long file can take
longer than one call is allowed to.
"""

from __future__ import annotations

import hashlib
import itertools
import json
import os
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path

import numpy as np
from ox1audio import serve

from audio import decode, encode, free_path
from wizard import detect_bpm, label, peaks

KEEP_TRACKS = 6
FORMATS = ("wav", "aiff", "flac", "mp3")

_pool = ThreadPoolExecutor(max_workers=2)
_jobs: dict[str, Future] = {}
_ids = itertools.count(1)


def open_track(call):
    """Decode a file into the data folder. The result says where its samples are."""
    return _start(_open, _source(_body(call).get("path")))


def save(call):
    """Encode samples the page rendered into ``renders/`` and put the file next to the original."""
    body = _body(call)
    rendered = _data_file(body.get("samples"), "renders")
    rate, channels = int(body.get("rate") or 0), int(body.get("channels") or 0)
    if not 1000 <= rate <= 768000 or not 1 <= channels <= 32:
        raise ValueError("Those samples are not audio.")
    kind = body.get("format") if body.get("format") in FORMATS else "wav"
    output = body.get("output")
    name = label(_number(body.get("pitch")), _number(body.get("formant")), _number(body.get("tempo"), 1.0), _number(body.get("bpm")) or None)
    return _start(_save, rendered, rate, channels, _source(body.get("source")), kind, output if isinstance(output, str) and output else None, name)


def status(call):
    ident = str(_body(call).get("id"))
    future = _jobs.get(ident)
    if future is None:
        raise ValueError("That job is gone.")
    if not future.done():
        return {"done": False}
    del _jobs[ident]
    error = future.exception()
    return {"done": True, "error": str(error) if error else None, "result": None if error else future.result()}


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
    peak = float(np.abs(audio).max()) if audio.size else 0.0
    if peak > 0.999:
        audio *= 0.999 / peak
    original = Path(source)
    folder = Path(output) if output else original.parent
    target = folder / f"{original.stem} ({name}).{kind}"
    written = encode(audio, rate, free_path(target, original), kind)
    return {"path": str(written), "name": written.name}


def _prune(folder: Path) -> None:
    kept = sorted(folder.glob("*.f32"), key=lambda item: item.stat().st_mtime, reverse=True)
    for old in kept[KEEP_TRACKS:]:
        old.unlink(missing_ok=True)
        old.with_suffix(".json").unlink(missing_ok=True)


def _start(work, *args) -> dict:
    ident = str(next(_ids))
    _jobs[ident] = _pool.submit(work, *args)
    return {"id": ident}


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
        raise ValueError("Those samples are gone.")
    return path


def _body(call) -> dict:
    return call.body if isinstance(call.body, dict) else {}


def _source(value) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError("Choose an audio file.")
    path = Path(value)
    if not path.is_file():
        raise ValueError(f"{path.name} is not there anymore.")
    return str(path.resolve())


def _number(value, fallback: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return number if np.isfinite(number) else fallback


if __name__ == "__main__":
    serve({"open": open_track, "save": save, "status": status})
