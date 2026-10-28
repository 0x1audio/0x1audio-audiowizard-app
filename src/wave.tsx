import { useEffect, useMemo, useReducer, useRef, useState } from "react"
import { PauseIcon, PlayIcon } from "@phosphor-icons/react"
import { Button, Spinner } from "@0x1audio/design-system"
import WaveSurfer, { type WaveSurferOptions } from "wavesurfer.js"

import { duration as clock } from "./drop.ts"
import { isNeutral, outline, type Change, type Player, type Samples } from "./engine.ts"

// The changed track is drawn as bars over a faint silhouette of the original,
// both on one time scale, so a new tempo changes the length you see and pitch
// or formant changes show where the level moved. Sound comes from the Player;
// wavesurfer only draws.
export function Waveform({
  player,
  rough,
  peaks: early,
  duration,
  change,
}: {
  player: Player | null
  rough: Samples | null
  peaks: number[]
  duration: number
  change: Change
}) {
  const original = useOutline(rough, null) ?? early
  const changed = useOutline(rough, change) ?? original
  const top = Math.max(1e-6, ...original)
  const length = duration / change.tempo
  const longest = Math.max(duration, length)
  const neutral = isNeutral(change)

  const ghost = useSurfer(useMemo(() => original.map((peak) => Math.min(1, peak / top)), [original, top]), duration, {
    waveColor: color("--fg-muted", "#71717a"),
    progressColor: color("--fg-muted", "#71717a"),
    cursorWidth: 0,
    interact: false,
  })
  const latest = useRef({ player, tempo: change.tempo })
  latest.current = { player, tempo: change.tempo }
  const [, redraw] = useReducer((count: number) => count + 1, 0)

  const main = useSurfer(
    useMemo(() => changed.map((peak) => Math.min(1, peak / top)), [changed, top]),
    length,
    {
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      barMinHeight: 1,
      cursorWidth: 2,
      cursorColor: color("--fg-base", "#f4f4f5"),
      waveColor: color("--fg-muted", "#71717a"),
      progressColor: color("--fg-base", "#f4f4f5"),
      interact: true,
      dragToSeek: true,
    },
    () => (latest.current.player?.time ?? 0) / latest.current.tempo,
  )

  useEffect(() => {
    return main.wave?.on("interaction", (time) => latest.current.player?.seek(time * latest.current.tempo))
  }, [main.wave])

  useEffect(() => {
    if (!player) return
    player.listen(() => {
      main.wave?.setTime(player.time / latest.current.tempo)
      redraw()
    })
    return () => player.listen(() => {})
  }, [player, main.wave])

  const time = player?.time ?? 0
  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-card p-4">
      <div className="relative h-32">
        <div ref={ghost.box} className={`pointer-events-none absolute inset-y-0 left-0 opacity-25 ${neutral ? "invisible" : ""}`} style={{ width: `${(duration / longest) * 100}%` }} />
        <div ref={main.box} className="relative h-full cursor-pointer" style={{ width: `${(length / longest) * 100}%` }} />
      </div>
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          className="h-10 w-10 px-0"
          aria-label={player?.playing ? "Pause" : "Play"}
          disabled={!player}
          onClick={() => (player?.playing ? player.pause() : player?.play())}
        >
          {!player ? <Spinner className="size-4" /> : player.playing ? <PauseIcon size={16} weight="fill" /> : <PlayIcon size={16} weight="fill" />}
        </Button>
        <span className="text-sm text-muted-foreground tabular-nums">
          {clock(Math.floor(time / change.tempo))} / {clock(length)}
        </span>
        {neutral ? null : <span className="text-sm text-muted-foreground">Original {clock(duration)}</span>}
      </div>
    </div>
  )
}

// Peaks of the track after ``change`` (or as it is, for null). While a new
// render runs, the last one stays up so the picture never flashes back.
function useOutline(rough: Samples | null, change: Change | null) {
  const [result, setResult] = useState<{ rough: Samples; peaks: number[] } | null>(null)
  const pitch = change?.pitch ?? 0
  const formant = change?.formant ?? 0
  const tempo = change?.tempo ?? 1

  useEffect(() => {
    if (!rough) return
    let stale = false
    const timer = window.setTimeout(() => {
      queue(async () => {
        if (stale) return
        const peaks = await outline(rough, { pitch, formant, tempo })
        if (!stale) setResult({ rough, peaks })
      })
    }, 60)
    return () => {
      stale = true
      window.clearTimeout(timer)
    }
  }, [rough, pitch, formant, tempo])

  return result?.rough === rough ? result.peaks : null
}

// One render at a time. Renders that went stale while waiting are skipped.
let line: Promise<void> = Promise.resolve()

function queue(job: () => Promise<void>) {
  line = line.then(job).catch(() => {})
}

function useSurfer(peaks: number[], seconds: number, options: Omit<WaveSurferOptions, "container">, at: () => number = () => 0) {
  const box = useRef<HTMLDivElement>(null)
  const [wave, setWave] = useState<WaveSurfer | null>(null)
  const position = useRef(at)
  position.current = at

  useEffect(() => {
    if (!box.current) return
    const drawn = WaveSurfer.create({ ...options, container: box.current, height: 128, normalize: false, hideScrollbar: true, fillParent: true })
    setWave(drawn)
    return () => drawn.destroy()
    // Options are fixed for the life of the component.
  }, [])

  useEffect(() => {
    if (!wave || !peaks.length || !(seconds > 0)) return
    void wave.load("", [peaks], seconds).then(() => wave.setTime(position.current()))
  }, [wave, peaks, seconds])

  return { box, wave }
}

function color(name: string, fallback: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}
