import { useEffect, useRef, useState } from "react"
import { host } from "@0x1audio/sdk/page"

// Files dropped anywhere on the window. Electron only gives a page the real
// path through the host, so an older 0x1audio reports that instead.
export function useDrop(onPaths: (paths: string[]) => void, onProblem: (message: string) => void) {
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)
  const latest = useRef({ onPaths, onProblem })
  latest.current = { onPaths, onProblem }

  useEffect(() => {
    const carriesFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") === true
    const enter = (event: DragEvent) => {
      if (!carriesFiles(event)) return
      event.preventDefault()
      depth.current += 1
      setDragging(true)
    }
    const over = (event: DragEvent) => {
      if (!carriesFiles(event)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy"
    }
    const leave = (event: DragEvent) => {
      if (!carriesFiles(event)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setDragging(false)
    }
    const drop = (event: DragEvent) => {
      event.preventDefault()
      depth.current = 0
      setDragging(false)
      const files = Array.from(event.dataTransfer?.files ?? [])
      if (!files.length) return
      const bridge = host()
      if (!bridge?.pathFor) {
        latest.current.onProblem("Update 0x1audio to drop files here, or use Choose audio.")
        return
      }
      const paths = files.map((file) => bridge.pathFor?.(file) ?? "").filter(Boolean)
      if (paths.length) latest.current.onPaths(paths)
    }
    window.addEventListener("dragenter", enter)
    window.addEventListener("dragover", over)
    window.addEventListener("dragleave", leave)
    window.addEventListener("drop", drop)
    return () => {
      window.removeEventListener("dragenter", enter)
      window.removeEventListener("dragover", over)
      window.removeEventListener("dragleave", leave)
      window.removeEventListener("drop", drop)
    }
  }, [])

  return dragging
}

export function basename(path: string) {
  return path.split(/[/\\]/).pop() ?? path
}

export function duration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00"
  const whole = Math.round(seconds)
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const rest = String(whole % 60).padStart(2, "0")
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`
}

export function channels(count: number) {
  if (count === 1) return "Mono"
  if (count === 2) return "Stereo"
  return `${count} channels`
}

export function rate(hz: number) {
  return `${(hz / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })} kHz`
}
