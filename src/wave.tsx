import { useEffect, useRef, useState } from "react"
import { PauseIcon, PlayIcon } from "@phosphor-icons/react"
import { Button } from "@0x1audio/design-system"
import WaveSurfer from "wavesurfer.js"

import { duration as formatTime } from "./drop.ts"

export function Waveform({
  src,
  peaks,
  duration,
  updating,
}: {
  src: string
  peaks: number[]
  duration: number
  updating: boolean
}) {
  const box = useRef<HTMLDivElement>(null)
  const wave = useRef<WaveSurfer | null>(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)

  useEffect(() => {
    const container = box.current
    if (!container) return
    const style = getComputedStyle(document.documentElement)
    const base = style.getPropertyValue("--fg-base").trim() || "#f4f4f5"
    const muted = style.getPropertyValue("--fg-muted").trim() || "#71717a"
    const player = WaveSurfer.create({
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
    player.on("play", () => setPlaying(true))
    player.on("pause", () => setPlaying(false))
    player.on("finish", () => setPlaying(false))
    player.on("timeupdate", (value) => setTime(value))
    player.on("seeking", (value) => setTime(value))
    wave.current = player
    return () => {
      wave.current = null
      player.destroy()
    }
  }, [])

  useEffect(() => {
    const player = wave.current
    if (!player || !peaks.length || !src || !duration) return
    let dropped = false
    const current = player.getDuration()
    const ratio = current > 0 ? player.getCurrentTime() / current : 0
    const resume = player.isPlaying()
    void player
      .load(src, [peaks], duration)
      .then(() => {
        if (dropped) return
        const next = player.getDuration() || duration
        if (ratio > 0) player.setTime(Math.min(Math.max(0, next - 0.05), ratio * next))
        if (resume) void player.play()
      })
      .catch(() => {})
    return () => {
      dropped = true
    }
  }, [src, peaks, duration])

  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-card p-4">
      <div ref={box} className={`cursor-pointer ${updating ? "opacity-50" : ""}`} />
      <div className="flex items-center gap-3">
        <Button variant="outline" className="h-10 w-10 px-0" aria-label={playing ? "Pause" : "Play"} onClick={() => void wave.current?.playPause()}>
          {playing ? <PauseIcon size={16} weight="fill" /> : <PlayIcon size={16} weight="fill" />}
        </Button>
        <span className="text-sm text-muted-foreground">
          {formatTime(time)} / {formatTime(duration)}
        </span>
        {updating ? <span className="text-sm text-muted-foreground">Updating</span> : null}
      </div>
    </div>
  )
}
