"""audioWizard worker. Analyze a file, then render previews and exports from it.

Both are jobs the page polls, because long files can outlast a single call.
"""

from __future__ import annotations

import hashlib
import os
import threading
import time
from collections import OrderedDict
from pathlib import Path

from ox1audio import serve
from ox1audio.data import root

from audio import decode, encode, free_path
from wizard import Change, detect_bpm, label, process

_jobs: dict[str, dict] = {}
_lock = threading.Lock()
_seq = 0
_decoded: OrderedDict[tuple[str, float], tuple] = OrderedDict()
_decode_lock = threading.Lock()
KEEP_DECODED = 3
KEEP_PREVIEWS = 24


def analyze(call):
    body = call.body if isinstance(call.body, dict) else {}
    path = _path(body.get("path"))
    job = _reserve("Reading")
    threading.Thread(target=_analyze, args=(job, path), daemon=True).start()
    return {"id": job}


def render(call):
    body = call.body if isinstance(call.body, dict) else {}
    path = _path(body.get("path"))
    change = Change(
        pitch=_clamp(body.get("pitch"), -24, 24),
        formant=_clamp(body.get("formant"), -12, 12),
        tempo=_tempo(body.get("source_bpm"), body.get("target_bpm")),
        transients=str(body.get("transients") or "crisp"),
    )
    preview = bool(body.get("preview"))
    options = {
        "preview": preview,
        "start": max(0.0, _number(body.get("start"), 0.0)),
        "length": min(120.0, max(2.0, _number(body.get("length"), 30.0))),
        "format": str(body.get("format") or "wav"),
        "output": body.get("output") if isinstance(body.get("output"), str) and body.get("output") else None,
        "bpm": _number(body.get("target_bpm"), 0.0) or None,
    }
    job = _reserve("Reading")
    threading.Thread(target=_render, args=(job, path, change, options), daemon=True).start()
    return {"id": job}


def status(call):
    body = call.body if isinstance(call.body, dict) else {}
    with _lock:
        job = _jobs.get(str(body.get("id")))
        if job is None:
            raise ValueError("That job is gone.")
        return dict(job)


def cancel(call):
    body = call.body if isinstance(call.body, dict) else {}
    with _lock:
        job = _jobs.get(str(body.get("id")))
        if job and not job["done"]:
            job.update(done=True, cancelled=True, stage="Stopped")
    return {"ok": True}


def _analyze(job: str, path: str) -> None:
    try:
        audio, info = _load(path)
        _update(job, stage="Finding the tempo")
        bpm = detect_bpm(audio, info.rate)
        _finish(job, result={**info.json(), "bpm": bpm})
    except Exception as exc:
        _finish(job, error=str(exc))


def _render(job: str, path: str, change: Change, options: dict) -> None:
    started = time.monotonic()
    try:
        audio, info = _load(path)
        if options["preview"]:
            first = int(options["start"] * info.rate)
            if first >= audio.shape[1]:
                first = 0
            audio = audio[:, first : first + int(options["length"] * info.rate)]
        if _stopped(job):
            return
        _update(job, stage="Changing")
        changed = process(audio, info.rate, change)
        if _stopped(job):
            return
        _update(job, stage="Saving")
        if options["preview"]:
            target = _preview_path(path, change, options)
            written = encode(changed, info.rate, target, "wav")
            _prune_previews(written.parent)
        else:
            stem = Path(info.path).stem
            folder = Path(options["output"]) if options["output"] else Path(info.path).parent
            ext = {"aiff": "aiff", "flac": "flac", "mp3": "mp3"}.get(options["format"], "wav")
            target = folder / f"{stem} ({label(change, options['bpm'])}).{ext}"
            written = encode(changed, info.rate, free_path(target, Path(info.path)), options["format"])
        _finish(
            job,
            result={
                "path": str(written),
                "name": written.name,
                "duration": changed.shape[1] / info.rate,
                "elapsed": time.monotonic() - started,
            },
        )
    except Exception as exc:
        _finish(job, error=str(exc))


def _load(path: str):
    key = (path, os.path.getmtime(path))
    with _decode_lock:
        if key in _decoded:
            _decoded.move_to_end(key)
            return _decoded[key]
        loaded = decode(path)
        _decoded[key] = loaded
        while len(_decoded) > KEEP_DECODED:
            _decoded.popitem(last=False)
        return loaded


def _preview_path(path: str, change: Change, options: dict) -> Path:
    key = f"{path}|{change}|{options['start']:.2f}|{options['length']:.2f}|{time.time_ns()}"
    return root() / "previews" / f"{hashlib.sha1(key.encode()).hexdigest()[:16]}.wav"


def _prune_previews(folder: Path) -> None:
    files = sorted(folder.glob("*.wav"), key=lambda item: item.stat().st_mtime, reverse=True)
    for old in files[KEEP_PREVIEWS:]:
        old.unlink(missing_ok=True)


def _reserve(stage: str) -> str:
    global _seq
    with _lock:
        _seq += 1
        ident = str(_seq)
        _jobs[ident] = {"stage": stage, "done": False, "cancelled": False, "error": None, "result": None}
        return ident


def _update(job: str, **fields) -> None:
    with _lock:
        if not _jobs[job]["done"]:
            _jobs[job].update(fields)


def _finish(job: str, **fields) -> None:
    with _lock:
        if _jobs[job]["done"]:
            return
        _jobs[job].update(done=True, stage="Done", **fields)


def _stopped(job: str) -> bool:
    with _lock:
        return _jobs[job]["cancelled"]


def _path(value) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError("Choose an audio file.")
    path = Path(value)
    if not path.is_file():
        raise ValueError(f"{path.name} is not there anymore.")
    return str(path.resolve())


def _number(value, fallback: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return number if number == number and abs(number) != float("inf") else fallback


def _clamp(value, low: float, high: float) -> float:
    return min(high, max(low, _number(value, 0.0)))


def _tempo(source, target) -> float:
    source, target = _number(source, 0.0), _number(target, 0.0)
    if source <= 0 or target <= 0:
        return 1.0
    ratio = target / source
    if not 0.25 <= ratio <= 4.0:
        raise ValueError("Keep the new BPM between a quarter and four times the original.")
    return ratio


if __name__ == "__main__":
    serve({"analyze": analyze, "render": render, "status": status, "cancel": cancel})
