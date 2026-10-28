"""Pitch, formant, and tempo changes built on Rubber Band (through pedalboard).

Formant is moved on its own by resampling first, which shifts pitch, formants,
and speed together, then letting Rubber Band put pitch and speed back while it
keeps the new formants in place.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

TRANSIENTS = ("crisp", "mixed", "smooth")


@dataclass(frozen=True)
class Change:
    pitch: float = 0.0
    formant: float = 0.0
    tempo: float = 1.0
    transients: str = "crisp"

    def neutral(self) -> bool:
        return abs(self.pitch) < 1e-6 and abs(self.formant) < 1e-6 and abs(self.tempo - 1.0) < 1e-6


def process(audio: np.ndarray, rate: int, change: Change) -> np.ndarray:
    """Return a changed copy of ``audio``, shaped (channels, frames)."""
    x = np.ascontiguousarray(audio, dtype=np.float32)
    if change.neutral() or x.shape[-1] == 0:
        return x.copy()
    if not 0.25 <= change.tempo <= 4.0:
        raise ValueError("Keep the tempo between a quarter and four times the original.")
    transients = change.transients if change.transients in TRANSIENTS else "crisp"

    import pedalboard

    ratio = 1.0
    if abs(change.formant) > 1e-6:
        import soxr

        ratio = 2.0 ** (change.formant / 12.0)
        x = np.ascontiguousarray(soxr.resample(x.T, rate * ratio, rate, quality="VHQ").T, dtype=np.float32)

    stretch = change.tempo / ratio
    shift = change.pitch - change.formant
    if abs(stretch - 1.0) > 1e-6 or abs(shift) > 1e-6:
        x = pedalboard.time_stretch(
            x,
            float(rate),
            stretch_factor=float(stretch),
            pitch_shift_in_semitones=float(shift),
            high_quality=True,
            transient_mode=transients,
            preserve_formants=True,
        )
    x = np.asarray(x, dtype=np.float32)
    peak = float(np.max(np.abs(x))) if x.size else 0.0
    if peak > 0.999:
        x *= 0.999 / peak
    return x


def detect_bpm(audio: np.ndarray, rate: int, seconds: float = 90.0) -> float | None:
    """Estimate the tempo from the first ``seconds`` of audio. ``None`` when there is no clear beat."""
    mono = np.asarray(audio, dtype=np.float32)
    if mono.ndim == 2:
        mono = mono.mean(axis=0)
    mono = mono[: int(rate * seconds)]
    if rate > 24000:
        import soxr

        mono = soxr.resample(mono, rate, 22050)
        rate = 22050
    size, hop = 1024, 128
    if mono.size < size * 16:
        return None

    frames = np.lib.stride_tricks.sliding_window_view(mono, size)[::hop]
    spectrum = np.abs(np.fft.rfft(frames * np.hanning(size).astype(np.float32), axis=1)).astype(np.float32)
    flux = np.maximum(0.0, np.diff(np.log1p(100.0 * spectrum), axis=0)).sum(axis=1)
    fps = rate / hop
    width = max(1, int(fps * 0.4))
    flux = np.maximum(0.0, flux - np.convolve(flux, np.ones(width) / width, mode="same"))
    if not np.any(flux):
        return None
    flux -= flux.mean()

    n = flux.size
    spectrum = np.fft.rfft(flux, 2 * n)
    corr = np.fft.irfft(spectrum * np.conj(spectrum))[:n]
    if corr[0] <= 0:
        return None
    corr /= corr[0]

    def at(lag: np.ndarray) -> np.ndarray:
        return np.interp(lag, np.arange(n), corr, right=0.0)

    candidates = np.arange(60.0, 200.0, 0.05)
    lags = 60.0 * fps / candidates
    score = at(lags) + 0.5 * at(lags / 2) + 0.25 * at(2 * lags)
    score *= np.exp(-0.5 * (np.log2(candidates / 120.0) / 0.7) ** 2)
    best = int(np.argmax(score))
    if score[best] < 0.05:
        return None
    # Half time and double time are both "right"; producers mostly count the faster one.
    if candidates[best] < 78:
        best = int(np.argmin(np.abs(candidates - candidates[best] * 2)))

    # Far multiples of the beat pin the period down much finer than one lag.
    near = np.arange(candidates[best] - 1.5, candidates[best] + 1.5, 0.01)
    lags = 60.0 * fps / near
    usable = [k for k in range(1, 17) if k * lags.max() < n * 0.8]
    fine = sum(at(k * lags) for k in usable)
    bpm = float(near[int(np.argmax(fine))])
    whole = round(bpm)
    return float(whole) if abs(bpm - whole) <= 0.2 else round(bpm, 1)


def label(change: Change, bpm: float | None) -> str:
    """The suffix that names an export, like ``pitch +3, formant -2, 128 BPM``."""
    parts = []
    if abs(change.pitch) > 1e-6:
        parts.append(f"pitch {_signed(change.pitch)}")
    if abs(change.formant) > 1e-6:
        parts.append(f"formant {_signed(change.formant)}")
    if abs(change.tempo - 1.0) > 1e-6:
        parts.append(f"{_number(bpm)} BPM" if bpm else f"{_number(change.tempo * 100)}% speed")
    return ", ".join(parts) or "copy"


def _signed(value: float) -> str:
    return ("+" if value > 0 else "") + _number(value)


def _number(value: float) -> str:
    return f"{value:.2f}".rstrip("0").rstrip(".")
