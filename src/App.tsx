import { useEffect, useRef, useState } from "react"
import { CheckCircleIcon, FileAudioIcon, FolderOpenIcon, PlusIcon, UploadSimpleIcon, WarningCircleIcon, XIcon } from "@phosphor-icons/react"
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Combobox,
  Input,
  Label,
  Slider,
  Spinner,
} from "@0x1audio/design-system"
import { host } from "@0x1audio/sdk/page"

import { basename, channels, duration, rate, useDrop } from "./drop.ts"
import { Waveform } from "./wave.tsx"

interface Track {
  path: string
  name: string
  status: "reading" | "ready" | "failed"
  error?: string
  rate?: number
  channels?: number
  duration?: number
  detected?: number | null
  peaks?: number[]
  sourceBpm: string
  targetBpm: string
  pitch: number
  formant: number
  shaping?: boolean
  shaped?: { signature: string; path: string; duration: number; peaks: number[] }
}

interface Job<T> {
  stage: string
  done: boolean
  cancelled: boolean
  error: string | null
  result: T | null
}

interface Analysis {
  rate: number
  channels: number
  duration: number
  bpm: number | null
  peaks: number[]
}

interface Heard {
  path: string
  duration: number
  peaks: number[]
}

interface Rendered {
  path: string
  name: string
  duration: number
  elapsed: number
}

const formats = [
  { value: "wav", label: "WAV, 24-bit" },
  { value: "aiff", label: "AIFF, 24-bit" },
  { value: "flac", label: "FLAC, 24-bit" },
  { value: "mp3", label: "MP3, 320 kb/s" },
]

export function App() {
  const [tracks, setTracks] = useState<Track[]>([])
  const [selected, setSelected] = useState("")
  const [format, setFormat] = useState("wav")
  const [output, setOutput] = useState("")
  const [busy, setBusy] = useState("")
  const [results, setResults] = useState<Rendered[]>([])
  const [message, setMessage] = useState("")
  const known = useRef(new Set<string>())

  const dragging = useDrop((paths) => add(paths), setMessage)
  const track = tracks.find((item) => item.path === selected) ?? tracks[0]

  function update(path: string, patch: Partial<Track>) {
    setTracks((current) => current.map((item) => (item.path === path ? { ...item, ...patch } : item)))
  }

  function add(paths: string[]) {
    const fresh = paths.filter((path) => !known.current.has(path))
    if (!fresh.length) return
    setMessage("")
    for (const path of fresh) known.current.add(path)
    setTracks((current) => [
      ...current,
      ...fresh.map((path) => ({
        path,
        name: basename(path),
        status: "reading" as const,
        sourceBpm: "",
        targetBpm: "",
        pitch: 0,
        formant: 0,
      })),
    ])
    setSelected(fresh[0])
    for (const path of fresh) void analyze(path)
  }

  async function analyze(path: string) {
    const bridge = host()
    if (!bridge) {
      update(path, { status: "failed", error: "Open this app in 0x1audio." })
      return
    }
    try {
      const { id } = await bridge.call<{ id: string }>("analyze", { path })
      const job = await wait<Analysis>(id)
      if (job.error || !job.result) throw new Error(job.error ?? "Could not read this file.")
      const bpm = job.result.bpm ? String(job.result.bpm) : ""
      update(path, {
        status: "ready",
        rate: job.result.rate,
        channels: job.result.channels,
        duration: job.result.duration,
        detected: job.result.bpm,
        peaks: job.result.peaks,
        sourceBpm: bpm,
        targetBpm: bpm,
      })
    } catch (error) {
      update(path, { status: "failed", error: error instanceof Error ? error.message : "Could not read this file." })
    }
  }

  function remove(path: string) {
    known.current.delete(path)
    setTracks((current) => current.filter((item) => item.path !== path))
    if (selected === path) setSelected("")
  }

  async function choose() {
    const bridge = host()
    if (!bridge?.pick) {
      setMessage("Open this app in 0x1audio.")
      return
    }
    add(await bridge.pick("file"))
  }

  async function chooseFolder() {
    const picked = await host()?.pick?.("folder")
    if (picked?.[0]) setOutput(picked[0])
  }

  useEffect(() => {
    if (!track || track.status !== "ready" || !track.peaks?.length) return
    const problem = tempoProblem(track)
    if (problem) {
      setMessage(problem)
      return
    }
    const sig = signature(track)
    if (neutral(track) || track.shaped?.signature === sig) {
      if (track.shaping) update(track.path, { shaping: false })
      return
    }
    const item = track
    let aborted = false
    let jobId = ""
    const timer = window.setTimeout(() => {
      void (async () => {
        const bridge = host()
        if (!bridge || aborted) return
        update(item.path, { shaping: true })
        setMessage("")
        try {
          const created = await bridge.call<{ id: string }>("listen", {
            path: item.path,
            pitch: item.pitch,
            formant: item.formant,
            source_bpm: Number(item.sourceBpm) || null,
            target_bpm: Number(item.targetBpm) || null,
          })
          jobId = created.id
          if (aborted) {
            void bridge.call("cancel", { id: jobId })
            return
          }
          const job = await wait<Heard>(jobId)
          if (aborted || job.cancelled) return
          if (job.error || !job.result) throw new Error(job.error ?? "Could not update the waveform.")
          update(item.path, {
            shaping: false,
            shaped: { signature: sig, path: job.result.path, duration: job.result.duration, peaks: job.result.peaks },
          })
        } catch (error) {
          if (aborted) return
          update(item.path, { shaping: false })
          setMessage(error instanceof Error ? error.message : "Could not update the waveform.")
        }
      })()
    }, 400)
    return () => {
      aborted = true
      window.clearTimeout(timer)
      if (jobId) void host()?.call("cancel", { id: jobId })
    }
  }, [track?.path, track?.status, track?.peaks, track?.pitch, track?.formant, track?.sourceBpm, track?.targetBpm, track?.shaped?.signature])

  async function render(item: Track) {
    const bridge = host()
    if (!bridge) throw new Error("Open this app in 0x1audio.")
    const { id } = await bridge.call<{ id: string }>("render", {
      path: item.path,
      pitch: item.pitch,
      formant: item.formant,
      source_bpm: Number(item.sourceBpm) || null,
      target_bpm: Number(item.targetBpm) || null,
      format,
      output,
    })
    const job = await wait<Rendered>(id, (state) => setBusy(state.stage))
    if (job.error || !job.result) throw new Error(job.error ?? "Something went wrong.")
    return job.result
  }

  async function exportTracks(items: Track[]) {
    const ready = items.filter((item) => item.status === "ready")
    const problem = ready.map(tempoProblem).find(Boolean)
    if (problem) return setMessage(problem)
    setMessage("")
    try {
      for (const [index, item] of ready.entries()) {
        setBusy(ready.length > 1 ? `${item.name} (${index + 1} of ${ready.length})` : "Changing")
        const done = await render(item)
        setResults((current) => [done, ...current])
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Something went wrong.")
    } finally {
      setBusy("")
    }
  }

  const ready = tracks.filter((item) => item.status === "ready")
  const working = busy !== ""

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-10 text-foreground">
      <header className="flex flex-col gap-2">
        <h1 className="text-xl font-medium">audioWizard</h1>
        <p className="text-sm text-muted-foreground">Change pitch, formant, and tempo, each one on its own.</p>
      </header>

      {tracks.length === 0 ? (
        <section
          className={`flex flex-col items-center justify-center gap-3 rounded-2xl px-6 py-16 text-center ${dragging ? "bg-[var(--bg-field)]" : "bg-card"}`}
        >
          <UploadSimpleIcon size={32} className="text-muted-foreground" />
          <div className="flex flex-col gap-1">
            <p className="font-medium">{dragging ? "Drop to add" : "Drop audio here"}</p>
            <p className="text-sm text-muted-foreground">Drop as many files as you like. Each one keeps its own settings.</p>
          </div>
          <Button variant="outline" onClick={() => void choose()}>
            <FolderOpenIcon size={16} />
            Choose audio
          </Button>
        </section>
      ) : (
        <section className="flex flex-col gap-2">
          <ul className="flex flex-col gap-2">
            {tracks.map((item) => (
              <li key={item.path}>
                <div
                  className={`relative flex items-center gap-3 rounded-xl bg-card px-4 py-3 ${item.path === track?.path ? "before:absolute before:inset-y-3 before:left-1.5 before:w-1 before:rounded-full before:bg-[var(--button-inverted)]" : ""}`}
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left"
                    onClick={() => setSelected(item.path)}
                  >
                    {item.status === "reading" ? (
                      <Spinner className="size-5 shrink-0" />
                    ) : item.status === "failed" ? (
                      <WarningCircleIcon size={20} className="shrink-0 text-destructive" />
                    ) : (
                      <FileAudioIcon size={20} className="shrink-0 text-muted-foreground" />
                    )}
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm font-medium">{item.name}</span>
                      <span className={`truncate text-xs ${item.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}>
                        {summary(item)}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${item.name}`}
                    disabled={working}
                    className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground hover:bg-[var(--button-neutral-hover)] hover:text-foreground disabled:opacity-50"
                    onClick={() => remove(item.path)}
                  >
                    <XIcon size={16} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <Button variant="outline" className={`self-start ${dragging ? "bg-[var(--bg-field)]" : ""}`} onClick={() => void choose()}>
            <PlusIcon size={16} />
            {dragging ? "Drop to add" : "Add audio"}
          </Button>
        </section>
      )}

      {track?.status === "ready" && track.peaks?.length && track.duration ? (
        <Waveform
          key={track.path}
          src={fileUrl(shown(track).path)}
          peaks={shown(track).peaks}
          duration={shown(track).duration}
          updating={Boolean(track.shaping)}
        />
      ) : null}

      {track?.status === "ready" ? (
        <Editor key={track.path} track={track} disabled={working} onChange={(patch) => update(track.path, patch)} />
      ) : null}

      {ready.length ? (
        <Card>
          <CardHeader>
            <CardTitle>Export</CardTitle>
            <CardDescription>Saved next to each original unless you pick a folder. Nothing is overwritten.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label>Format</Label>
              <Combobox items={formats} value={format} onValueChange={(value) => setFormat(value || "wav")} />
            </div>
            <div className="flex flex-col gap-2">
              <Label>Folder</Label>
              <div className="flex gap-2">
                <div className="flex h-10 min-w-0 flex-1 items-center rounded-lg bg-[var(--bg-field)] px-4 text-sm">
                  <span className="truncate text-muted-foreground">{output || "Same folder as each file"}</span>
                </div>
                {output ? (
                  <Button variant="outline" disabled={working} onClick={() => setOutput("")}>
                    Reset
                  </Button>
                ) : null}
                <Button variant="outline" disabled={working} onClick={() => void chooseFolder()}>
                  Choose
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {ready.length ? (
        <div className="flex gap-2">
          {track?.status === "ready" ? (
            <Button className="h-12 flex-1 text-base" disabled={working} onClick={() => void exportTracks([track])}>
              Export {ready.length > 1 ? "this one" : ""}
            </Button>
          ) : null}
          {ready.length > 1 ? (
            <Button variant="outline" className="h-12 flex-1 text-base" disabled={working} onClick={() => void exportTracks(ready)}>
              Export all {ready.length}
            </Button>
          ) : null}
        </div>
      ) : null}

      {working ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          {busy}…
        </p>
      ) : null}
      {message ? <p className="text-sm">{message}</p> : null}

      {results.length ? (
        <ul className="flex flex-col gap-2">
          {results.map((item) => (
            <li key={item.path} className="flex items-center gap-3 rounded-xl bg-card px-4 py-3">
              <CheckCircleIcon size={20} weight="fill" className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-sm">{item.name}</span>
              <Button variant="link" className="h-8 px-0" onClick={() => void host()?.reveal?.(item.path)}>
                Show in folder
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </main>
  )
}

function Editor({
  track,
  disabled,
  onChange,
}: {
  track: Track
  disabled: boolean
  onChange: (patch: Partial<Track>) => void
}) {
  const changed = !neutral(track)
  const speed = tempo(track)

  function scaleSource(factor: number) {
    const source = Number(track.sourceBpm)
    if (!source) return
    const next = trim(source * factor)
    onChange({ sourceBpm: next, targetBpm: track.targetBpm === track.sourceBpm ? next : track.targetBpm })
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <CardTitle>Change</CardTitle>
          <CardDescription>The waveform updates as you move these.</CardDescription>
        </div>
          <Button
            variant="link"
            className="h-6 px-0"
            disabled={disabled || !changed}
            onClick={() => onChange({ pitch: 0, formant: 0, targetBpm: track.sourceBpm })}
          >
            Reset
          </Button>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <Semitones label="Pitch" value={track.pitch} min={-24} max={24} disabled={disabled} onChange={(pitch) => onChange({ pitch })} />
          <Semitones label="Formant" value={track.formant} min={-12} max={12} disabled={disabled} onChange={(formant) => onChange({ formant })} />

          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-2">
              <Label>Original BPM</Label>
              <div className="flex gap-2">
                <Input
                  type="number"
                  inputMode="decimal"
                  min={20}
                  max={400}
                  step={0.01}
                  placeholder="Unknown"
                  value={track.sourceBpm}
                  disabled={disabled}
                  onChange={(event) => onChange({ sourceBpm: event.target.value })}
                />
                <Button variant="outline" className="px-3" disabled={disabled || !track.sourceBpm} onClick={() => scaleSource(0.5)}>
                  ½×
                </Button>
                <Button variant="outline" className="px-3" disabled={disabled || !track.sourceBpm} onClick={() => scaleSource(2)}>
                  2×
                </Button>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <Label>New BPM</Label>
              <Input
                type="number"
                inputMode="decimal"
                min={20}
                max={400}
                step={0.01}
                placeholder={track.sourceBpm ? track.sourceBpm : "Set the original first"}
                value={track.targetBpm}
                disabled={disabled || !track.sourceBpm}
                onChange={(event) => onChange({ targetBpm: event.target.value })}
              />
            </div>
          </div>
          <p className="-mt-3 text-xs text-muted-foreground">
            {track.detected ? `Detected ${track.detected} BPM.` : "No clear beat found. Type the BPM if you know it."}{" "}
            {speed && speed !== 1 ? `Plays at ${Math.round(speed * 1000) / 10}% speed.` : ""}
          </p>
        </CardContent>
      </Card>
  )
}

function Semitones({
  label,
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  disabled: boolean
  onChange: (value: number) => void
}) {
  const shown = value === 0 ? "0" : `${value > 0 ? "+" : "−"}${Math.abs(value)}`
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between text-sm">
        <Label>{label}</Label>
        <span className="text-muted-foreground">
          {shown} {Math.abs(value) === 1 ? "semitone" : "semitones"}
        </span>
      </div>
      <Slider
        value={value}
        min={min}
        max={max}
        step={0.5}
        disabled={disabled}
        onValueChange={(next) => onChange(typeof next === "number" ? next : next[0])}
      />
    </div>
  )
}

function summary(track: Track) {
  if (track.status === "reading") return "Reading…"
  if (track.status === "failed") return track.error ?? "Could not read this file."
  const parts = []
  if (track.detected) parts.push(`${track.detected} BPM`)
  if (track.rate) parts.push(rate(track.rate))
  if (track.channels) parts.push(channels(track.channels))
  if (track.duration) parts.push(duration(track.duration))
  return parts.join(" · ")
}

function tempo(track: Track) {
  const source = Number(track.sourceBpm)
  const target = Number(track.targetBpm)
  return source > 0 && target > 0 ? target / source : null
}

function tempoProblem(track: Track) {
  const speed = tempo(track)
  if (speed !== null && (speed < 0.25 || speed > 4)) {
    return `${track.name}: keep the new BPM between a quarter and four times the original.`
  }
  return ""
}

function neutral(track: Track) {
  return track.pitch === 0 && track.formant === 0 && track.targetBpm === track.sourceBpm
}

function shown(track: Track) {
  const current = !neutral(track) && track.shaped?.signature === signature(track) ? track.shaped : track.shaped
  if (!neutral(track) && current) return { path: current.path, peaks: current.peaks, duration: current.duration }
  return { path: track.path, peaks: track.peaks ?? [], duration: track.duration ?? 0 }
}

function signature(track: Track) {
  return JSON.stringify([track.pitch, track.formant, track.sourceBpm, track.targetBpm])
}

function trim(value: number) {
  return String(Math.round(value * 100) / 100)
}

function fileUrl(path: string) {
  const parts = path.replace(/\\/g, "/").split("/")
  const encoded = parts.map((part, index) => (index === 0 && /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part))).join("/")
  return `file://${encoded.startsWith("/") ? "" : "/"}${encoded}`
}

async function wait<T>(id: string, onUpdate?: (job: Job<T>) => void): Promise<Job<T>> {
  const bridge = host()
  if (!bridge) throw new Error("Open this app in 0x1audio.")
  for (;;) {
    const job = await bridge.call<Job<T>>("status", { id })
    onUpdate?.(job)
    if (job.done) return job
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
}
