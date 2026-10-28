import { useEffect, useReducer, useRef } from "react"
import { PauseIcon, PlayIcon } from "@phosphor-icons/react"
import { Button, Spinner } from "@0x1audio/design-system"
import WaveSurfer from "wavesurfer.js"

import { duration as clock } from "./drop.ts"
import type { Player } from "./engine.ts"

// wavesurfer only draws. Sound comes from the Player. A tempo change stretches
// the whole track evenly, so the picture stays the same and only the clock
// changes: the waveform works in original time, the clock shows changed time.
export function Waveform({
  player,
  peaks,
  duration,
  tempo,
}: {
  player: Player | null
  peaks: number[]
  duration: number
  tempo: number
}) {
  const box = useRef<HTMLDivElement>(null)
  const wave = useRef<WaveSurfer | null>(null)
  const latest = useRef(player)
  latest.current = player
  const [, redraw] = useReducer((count: number) => count + 1, 0)

  useEffect(() => {
    const container = box.current
    if (!container) return
    const style = getComputedStyle(document.documentElement)
    const base = style.getPropertyValue("--fg-base").trim() || "#f4f4f5"
    const muted = style.getPropertyValue("--fg-muted").trim() || "#71717a"
    const drawn = WaveSurfer.create({
      container,
      height: 128,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      barMinHeight: 1,
      cursorWidth: 2,
      cursorColor: base,
      waveColor: muted,
      progressColor: base,
      normalize: true,
      interact: true,
      dragToSeek: true,
      hideScrollbar: true,
      fillParent: true,
    })
    drawn.on("interaction", (time) => latest.current?.seek(time))
    void drawn.load("", [peaks], duration)
    wave.current = drawn
    return () => {
      wave.current = null
      drawn.destroy()
    }
  }, [peaks, duration])

  useEffect(() => {
    if (!player) return
    player.listen(() => {
      wave.current?.setTime(player.time)
      redraw()
    })
    return () => player.listen(() => {})
  }, [player])

  const time = player?.time ?? 0
  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-card p-4">
      <div ref={box} className="cursor-pointer" />
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
          {clock(Math.floor(time / tempo))} / {clock(duration / tempo)}
        </span>
      </div>
    </div>
  )
}
