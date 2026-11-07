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
