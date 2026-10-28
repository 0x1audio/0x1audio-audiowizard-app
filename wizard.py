"""What the worker works out about a track: its waveform, its tempo, and export names.

Pitch, formant, and tempo changes happen in the page, live, with Signalsmith Stretch.
"""

from __future__ import annotations

import numpy as np


def peaks(audio: np.ndarray, bars: int = 1000) -> list[float]:
    """Loudest sample of each slice, from 0 to 1, for drawing a waveform."""
    level = np.abs(audio).max(axis=0) if audio.ndim == 2 else np.abs(audio)
    if level.size == 0:
        return []
    bars = min(bars, level.size)
    starts = np.arange(bars, dtype=np.int64) * level.size // bars
    return np.round(np.maximum.reduceat(level, starts), 4).tolist()


def detect_bpm(audio: np.ndarray, rate: int, seconds: float = 90.0) -> float | None:
    """Estimate the tempo from the first ``seconds`` of audio. ``None`` when there is no clear beat."""
    mono = audio[..., : int(rate * seconds)]
    mono = mono.mean(axis=0) if mono.ndim == 2 else mono
    # Beats live in the low end, so halving the rate by averaging pairs loses nothing that matters.
    rate = float(rate)
    while rate > 32000:
        mono = mono[: mono.size // 2 * 2].reshape(-1, 2).mean(axis=1)
        rate /= 2
    size, hop = 1024, 128
    if mono.size < size * 16:
        return None

    frames = np.lib.stride_tricks.sliding_window_view(mono.astype(np.float32), size)[::hop]
    spectrum = np.abs(np.fft.rfft(frames * np.hanning(size).astype(np.float32), axis=1))
    flux = np.maximum(0.0, np.diff(np.log1p(100.0 * spectrum), axis=0)).sum(axis=1)
    fps = rate / hop
    width = max(1, int(fps * 0.4))
    flux = np.maximum(0.0, flux - np.convolve(flux, np.ones(width) / width, mode="same"))
    if not np.any(flux):
        return None
    flux -= flux.mean()

    n = flux.size
    transformed = np.fft.rfft(flux, 2 * n)
    corr = np.fft.irfft(transformed * np.conj(transformed))[:n]
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


def label(pitch: float, formant: float, tempo: float, bpm: float | None) -> str:
    """The suffix that names an export, like ``pitch +3, formant -2, 128 BPM``."""
    parts = []
    if abs(pitch) > 1e-6:
        parts.append(f"pitch {_signed(pitch)}")
    if abs(formant) > 1e-6:
        parts.append(f"formant {_signed(formant)}")
    if abs(tempo - 1.0) > 1e-6:
        parts.append(f"{_number(bpm)} BPM" if bpm else f"{_number(tempo * 100)}% speed")
    return ", ".join(parts) or "copy"


def _signed(value: float) -> str:
    return ("+" if value > 0 else "") + _number(value)


def _number(value: float) -> str:
    return f"{value:.2f}".rstrip("0").rstrip(".")
