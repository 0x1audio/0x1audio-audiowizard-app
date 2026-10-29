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

import { load, open, save, type Opened, type Saved } from "./bridge.ts"
import { basename, channels, duration, rate, useDrop } from "./drop.ts"
import { isNeutral, Player, render, sketch, unchanged, type Change, type Samples } from "./engine.ts"
import { Waveform } from "./wave.tsx"

interface Track {
  path: string
  name: string
  opened?: Opened
  error?: string
  sourceBpm: string
  targetBpm: string
  pitch: number
  formant: number
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
  const [player, setPlayer] = useState<Player | null>(null)
  const [rough, setRough] = useState<Samples | null>(null)
  const [format, setFormat] = useState("wav")
  const [output, setOutput] = useState("")
  const [busy, setBusy] = useState("")
  const [results, setResults] = useState<Saved[]>([])
  const [message, setMessage] = useState("")
  const loaded = useRef<{ path: string; samples: Samples } | null>(null)

  const dragging = useDrop((paths) => add(paths), setMessage)
  const track = tracks.find((item) => item.path === selected) ?? tracks[0]
  const change = track ? changeOf(track) : null

  function update(path: string, patch: Partial<Track>) {
    setTracks((current) => current.map((item) => (item.path === path ? { ...item, ...patch } : item)))
  }

  function add(paths: string[]) {
    const fresh = [...new Set(paths)].filter((path) => !tracks.some((item) => item.path === path))
    if (!fresh.length) return
    setMessage("")
    setTracks((current) => [
      ...current,
      ...fresh.map((path) => ({ path, name: basename(path), sourceBpm: "", targetBpm: "", pitch: 0, formant: 0 })),
    ])
    setSelected(fresh[0])
    for (const path of fresh) {
      open(path).then(
        (opened) => {
          const bpm = opened.bpm ? String(opened.bpm) : ""
          update(path, { opened, sourceBpm: bpm, targetBpm: bpm })
        },
        (error: unknown) => update(path, { error: problem(error, "Could not read this file.") }),
      )
    }
  }

  function remove(path: string) {
    setTracks((current) => current.filter((item) => item.path !== path))
    if (selected === path) setSelected("")
  }

  async function choose() {
    const bridge = host()
    if (!bridge?.pick) return setMessage("Open this app in 0x1audio.")
    add(await bridge.pick("file"))
  }

  async function chooseFolder() {
    const picked = await host()?.pick?.("folder")
    if (picked?.[0]) setOutput(picked[0])
  }

  // One player at a time, for the selected track. Its settings follow the controls live.
  const openedTrack = track?.opened ? track : null
  useEffect(() => {
    if (!openedTrack?.opened) return
    const { path, opened } = openedTrack
    let live = true
    let made: Player | null = null
    void (async () => {
      try {
        const samples = loaded.current?.path === path ? loaded.current.samples : await load(opened)
        loaded.current = { path, samples }
        if (live) setRough(sketch(samples))
        made = await Player.open(samples, changeOf(openedTrack) ?? unchanged)
        if (live) setPlayer(made)
        else made.close()
      } catch (error) {
        if (live) setMessage(problem(error, "Could not play this file."))
      }
    })()
    return () => {
      live = false
      made?.close()
      setPlayer(null)
      setRough(null)
    }
    // Rebuilt only for a different file. Changes reach the player through set().
  }, [openedTrack?.path, openedTrack?.opened])

  useEffect(() => {
    if (player && change) player.set(change)
  }, [player, change?.pitch, change?.formant, change?.tempo])

  const playback = useRef<Player | null>(null)
  playback.current = player
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.altKey || event.ctrlKey || event.metaKey) return
      if (typing(event.target)) return
      event.preventDefault()
      if (event.repeat) return
      const current = playback.current
      if (!current) return
      if (current.playing) current.pause()
      else current.play()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  async function exportTracks(items: Track[]) {
    const ready = items.filter((item) => item.opened)
    const wrong = ready.find((item) => !changeOf(item))
    if (wrong) return setMessage(`${wrong.name}: keep the new BPM between a quarter and four times the original.`)
    setMessage("")
    try {
      for (const [index, item] of ready.entries()) {
        const opened = item.opened as Opened
        const settings = changeOf(item) as Change
        const counter = ready.length > 1 ? ` (${index + 1} of ${ready.length})` : ""
        setBusy(`Changing ${item.name}${counter}`)
        const samples = loaded.current?.path === item.path ? loaded.current.samples : await load(opened)
        const changed = isNeutral(settings) ? samples.channels : await render(samples, settings)
        setBusy(`Saving ${item.name}${counter}`)
        const saved = await save(changed, {
          ...settings,
          rate: opened.rate,
          source: item.path,
          format,
          output,
          bpm: settings.tempo !== 1 ? Number(item.targetBpm) || null : null,
        })
        setResults((current) => [saved, ...current])
      }
    } catch (error) {
      setMessage(problem(error, "Something went wrong."))
    } finally {
      setBusy("")
    }
  }

  const ready = tracks.filter((item) => item.opened)
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
                    {item.error ? (
                      <WarningCircleIcon size={20} className="shrink-0 text-destructive" />
                    ) : item.opened ? (
                      <FileAudioIcon size={20} className="shrink-0 text-muted-foreground" />
                    ) : (
                      <Spinner className="size-5 shrink-0" />
                    )}
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm font-medium">{item.name}</span>
                      <span className={`truncate text-xs ${item.error ? "text-destructive" : "text-muted-foreground"}`}>{summary(item)}</span>
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

      {track?.opened ? (
        <>
          <Waveform
            player={player}
            rough={rough}
            peaks={track.opened.peaks}
            duration={track.opened.frames / track.opened.rate}
            change={change ?? unchanged}
          />
          <Editor key={track.path} track={track} disabled={working} onChange={(patch) => update(track.path, patch)} />
        </>
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
          {track?.opened ? (
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

function Editor({ track, disabled, onChange }: { track: Track; disabled: boolean; onChange: (patch: Partial<Track>) => void }) {
  const settings = changeOf(track)
  const changed = !settings || !isNeutral(settings)

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
          <CardDescription>You hear every change right away.</CardDescription>
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
          {track.opened?.bpm ? `Detected ${track.opened.bpm} BPM.` : "No clear beat found. Type the BPM if you know it."}{" "}
          {!settings
            ? "Keep the new BPM between a quarter and four times the original."
            : settings.tempo !== 1
              ? `Plays at ${Math.round(settings.tempo * 1000) / 10}% speed.`
              : ""}
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

// The change a track asks for, or null when its BPMs ask for an impossible tempo.
function changeOf(track: Track): Change | null {
  const source = Number(track.sourceBpm)
  const target = Number(track.targetBpm)
  const tempo = source > 0 && target > 0 ? target / source : 1
  if (tempo < 0.25 || tempo > 4) return null
  return { pitch: track.pitch, formant: track.formant, tempo }
}

function summary(track: Track) {
  if (track.error) return track.error
  if (!track.opened) return "Reading…"
  const { bpm, rate: hz, channels: count, frames } = track.opened
  return [bpm ? `${bpm} BPM` : "", rate(hz), channels(count), duration(frames / hz)].filter(Boolean).join(" · ")
}

function trim(value: number) {
  return String(Math.round(value * 100) / 100)
}

function problem(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

function typing(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const role = target.getAttribute("role")
  if (role === "textbox" || role === "searchbox" || role === "combobox") return true
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true
  if (!(target instanceof HTMLInputElement)) return false
  return !["button", "checkbox", "radio", "range", "file", "submit", "reset"].includes(target.type)
}
