import { useEffect, useRef, useState, type CSSProperties } from "react"
import {
  ArrowCounterClockwiseIcon,
  BooksIcon,
  CheckCircleIcon,
  FileAudioIcon,
  FolderOpenIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  WarningCircleIcon,
  XIcon,
} from "@phosphor-icons/react"
import {
  Button,
  Callout,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Label,
  LibraryDialog,
  PageSection,
  Skeleton,
  Slider,
  Spinner,
  Tabs,
  TabsList,
  TabsTab,
  cn,
  toast,
  transition,
  useFileDrop,
} from "@0x1audio/design-system"
import { ox } from "@0x1audio/sdk/page"

import { load, open, save, type Opened, type Saved } from "./bridge.ts"
import { basename, channels, duration, rate } from "./drop.ts"
import { isNeutral, Player, render, sketch, unchanged, type Change, type Samples } from "./engine.ts"
import { Hero } from "./hero.tsx"
import { DropOverlay, Intake, SaveTo, Working } from "./parts.tsx"
import { Waveform, WaveformSkeleton } from "./wave.tsx"

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

type Export =
  | { state: "idle" }
  | { state: "working"; label: string; progress: number; stopping: boolean }
  | { state: "failed"; message: string }

const formats = [
  { value: "wav", label: "WAV", detail: "24-bit, lossless." },
  { value: "aiff", label: "AIFF", detail: "24-bit, lossless." },
  { value: "flac", label: "FLAC", detail: "24-bit, lossless and smaller." },
  { value: "mp3", label: "MP3", detail: "320 kb/s. Smallest, plays anywhere." },
]

export function App() {
  const [tracks, setTracks] = useState<Track[]>([])
  const [selected, setSelected] = useState("")
  const [player, setPlayer] = useState<Player | null>(null)
  const [rough, setRough] = useState<Samples | null>(null)
  const [format, setFormat] = useState("wav")
  const [output, setOutput] = useState("")
  const [exporting, setExporting] = useState<Export>({ state: "idle" })
  const [results, setResults] = useState<Saved[]>([])
  const [message, setMessage] = useState("")
  const [library, setLibrary] = useState(false)
  const loaded = useRef<{ path: string; samples: Samples } | null>(null)
  const stopping = useRef(false)

  const dragging = useFileDrop((files) => {
    if (!ox.available()) {
      toast.error("Update 0x1audio to drop files here, or browse your Library.")
      return
    }
    const paths = files.map((file) => ox.files.fromDrop(file)).filter(Boolean)
    if (paths.length) add(paths)
  })
  const track = tracks.find((item) => item.path === selected) ?? tracks[0]
  const change = track ? changeOf(track) : null
  const working = exporting.state === "working"

  function update(path: string, patch: Partial<Track>) {
    setTracks((current) => current.map((item) => (item.path === path ? { ...item, ...patch } : item)))
  }

  function add(paths: string[]) {
    const fresh = [...new Set(paths)].filter((path) => !tracks.some((item) => item.path === path))
    if (!fresh.length) return
    setMessage("")
    // The files are opened only once they are in the list, so a quick answer always has a row to land on.
    transition(() => {
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
          (error: unknown) => update(path, { error: problem(error, "This file couldn't be read.") }),
        )
      }
    })
  }

  function remove(path: string) {
    const next = tracks.filter((item) => item.path !== path)
    const go = () => {
      setTracks(next)
      if (selected === path) setSelected(next[0]?.path ?? "")
    }
    if (next.length) go()
    else transition(go)
  }

  async function choose() {
    const picked = ox.available() ? await ox.files.pick({ multiple: true }) : []
    if (picked.length) add(picked)
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
        if (live) setMessage(problem(error, "This file couldn't be played."))
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
      else {
        window.dispatchEvent(new CustomEvent("track-play", { detail: "editor" }))
        current.play()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  async function exportTracks(items: Track[]) {
    const ready = items.filter((item) => item.opened)
    const wrong = ready.find((item) => !changeOf(item))
    if (wrong) {
      setExporting({ state: "failed", message: `${wrong.name}: keep the new BPM between a quarter and four times the original.` })
      return
    }
    stopping.current = false
    const steps = ready.length * 2
    const step = (done: number, label: string) =>
      setExporting((current) => ({ state: "working", label, progress: done / steps, stopping: current.state === "working" && current.stopping }))
    let finished = 0
    try {
      for (const [index, item] of ready.entries()) {
        if (stopping.current) break
        const opened = item.opened as Opened
        const settings = changeOf(item) as Change
        const counter = ready.length > 1 ? ` (${index + 1} of ${ready.length})` : ""
        step(index * 2, `Changing ${item.name}${counter}`)
        const samples = loaded.current?.path === item.path ? loaded.current.samples : await load(opened)
        const changed = isNeutral(settings) ? samples.channels : await render(samples, settings)
        if (stopping.current) break
        step(index * 2 + 1, `Saving ${item.name}${counter}`)
        const saved = await save(changed, {
          ...settings,
          rate: opened.rate,
          source: item.path,
          format,
          output,
          bpm: settings.tempo !== 1 ? Number(item.targetBpm) || null : null,
        })
        finished += 1
        setResults((current) => [saved, ...current.filter((result) => result.path !== saved.path)])
      }
      if (stopping.current) {
        toast("Stopped", { description: finished ? `${finished} of ${ready.length} saved.` : "Nothing was saved." })
      }
      setExporting({ state: "idle" })
    } catch (error) {
      setExporting({ state: "failed", message: problem(error, "The export didn't finish. Try again.") })
    }
  }

  function stop() {
    stopping.current = true
    setExporting((current) => (current.state === "working" ? { ...current, stopping: true } : current))
  }

  const ready = tracks.filter((item) => item.opened)
  const detail = formats.find((item) => item.value === format)?.detail

  return (
    <div data-app="audiowizard" className="min-h-svh bg-background text-foreground">
      <div className="mx-auto flex min-h-svh w-full max-w-3xl flex-col gap-8 px-8 pt-6 pb-10 max-sm:px-4 max-sm:pt-4">
        <Hero />

        {tracks.length === 0 ? (
          <Intake
            title="Drop audio here"
            description="Change the notes, the character of a voice, or the tempo, each on its own. Add as many files as you like."
            dragging={dragging}
            multiple
            onChoose={add}
          />
        ) : (
          <main className="flex animate-enter flex-col gap-6">
            <PageSection
              className="py-0"
              title="Files"
              actions={
                <DropdownMenu>
                  <DropdownMenuTrigger render={<Button variant="ghost" size="sm" className="-my-2 -mr-2.5" disabled={working} />}>
                    <PlusIcon />
                    Add audio
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-48">
                    <DropdownMenuItem onClick={() => void choose()}>
                      <FileAudioIcon />
                      Choose files…
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setLibrary(true)}>
                      <BooksIcon />
                      From your Library…
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              }
            >
              <ul className="flex flex-col gap-1">
                {tracks.map((item) => (
                  <FileRow
                    key={item.path}
                    track={item}
                    selected={item.path === track?.path}
                    disabled={working}
                    onSelect={() => {
                      setSelected(item.path)
                      setMessage("")
                    }}
                    onRemove={() => remove(item.path)}
                  />
                ))}
              </ul>
              <LibraryDialog open={library} multiple onOpenChange={setLibrary} onPick={add} />
            </PageSection>

            {track?.error ? (
              <Callout
                tone="danger"
                icon={<WarningCircleIcon />}
                title={`${track.name} couldn't be opened`}
                actions={
                  <Button variant="outline" size="sm" onClick={() => remove(track.path)}>
                    Remove it
                  </Button>
                }
              >
                {track.error}
              </Callout>
            ) : track?.opened ? (
              <>
                <Waveform
                  player={player}
                  rough={rough}
                  peaks={track.opened.peaks}
                  duration={track.opened.frames / track.opened.rate}
                  change={change ?? unchanged}
                />
                {message ? (
                  <Callout tone="warning" icon={<WarningCircleIcon />} title="This file can't play here">
                    {message}
                  </Callout>
                ) : null}
                <Editor key={track.path} track={track} disabled={working} onChange={(patch) => update(track.path, patch)} />
              </>
            ) : (
              <>
                <WaveformSkeleton />
                <EditorSkeleton />
              </>
            )}

            {ready.length ? (
              <PageSection className="py-0" title="Export" description="Saved as a new file. Nothing is overwritten.">
                <div className="flex flex-col gap-5 rounded-2xl bg-card p-5">
                  <div className="grid gap-5 sm:grid-cols-2">
                    <div role="group" aria-labelledby="format" className="flex min-w-0 flex-col gap-2">
                      <p id="format" className="text-sm leading-none font-medium">
                        Format
                      </p>
                      <Tabs value={format} onValueChange={(value) => setFormat(String(value))}>
                        <TabsList className="w-full">
                          {formats.map((item) => (
                            <TabsTab key={item.value} value={item.value} disabled={working} className="px-2">
                              {item.label}
                            </TabsTab>
                          ))}
                        </TabsList>
                      </Tabs>
                      <p className="text-[13px] text-muted-foreground">{detail}</p>
                    </div>
                    <SaveTo folder={output} disabled={working} onChange={setOutput} fallback="Next to each original" />
                  </div>

                  {exporting.state === "working" ? (
                    <Working
                      progress={exporting.progress}
                      label={exporting.label}
                      stopping={exporting.stopping}
                      stoppingLabel="Stopping after this file"
                      note="The originals stay as they are."
                      onCancel={stop}
                    />
                  ) : (
                    <div className="flex gap-2 max-sm:flex-col">
                      {track?.opened ? (
                        <Button size="lg" className="w-full sm:w-auto sm:flex-1" onClick={() => void exportTracks([track])}>
                          {ready.length > 1 ? "Export this file" : "Export"}
                        </Button>
                      ) : null}
                      {ready.length > 1 ? (
                        <Button size="lg" variant="outline" className="w-full sm:w-auto sm:flex-1" onClick={() => void exportTracks(ready)}>
                          Export all {ready.length}
                        </Button>
                      ) : null}
                    </div>
                  )}
                  {exporting.state === "failed" ? (
                    <Callout
                      tone="danger"
                      icon={<WarningCircleIcon />}
                      title="The export didn't finish"
                      ref={(node) => node?.scrollIntoView({ block: "nearest", behavior: "smooth" })}
                    >
                      {exporting.message}
                    </Callout>
                  ) : null}
                </div>
              </PageSection>
            ) : null}

            {results.length ? (
              <PageSection className="py-0" title="Exported" description="Each file is also in your Library.">
                <ul className="stagger flex flex-col gap-1">
                  {results.map((item, index) => (
                    <ResultRow key={item.path} result={item} index={index} />
                  ))}
                </ul>
              </PageSection>
            ) : null}
          </main>
        )}
      </div>
      {dragging ? <DropOverlay label="Drop to add" /> : null}
    </div>
  )
}

function FileRow({
  track,
  selected,
  disabled,
  onSelect,
  onRemove,
}: {
  track: Track
  selected: boolean
  disabled: boolean
  onSelect: () => void
  onRemove: () => void
}) {
  return (
    <li className={cn("group flex h-12 items-center gap-1 rounded-lg pr-1.5 hover:bg-hover", selected && "bg-selected hover:bg-selected")}>
      <button
        type="button"
        aria-current={selected || undefined}
        className="flex h-full min-w-0 flex-1 items-center gap-3 rounded-lg px-3 text-left"
        onClick={onSelect}
      >
        {track.error ? (
          <WarningCircleIcon size={16} className="shrink-0 text-destructive" />
        ) : track.opened ? (
          <FileAudioIcon size={16} className={cn("shrink-0", selected ? "text-brand" : "text-muted-foreground")} />
        ) : (
          <Spinner className="shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{track.name}</span>
        <span className={cn("shrink-0 truncate text-[13px] tabular-nums max-sm:hidden", track.error ? "text-destructive" : "text-muted-foreground")}>
          {summary(track)}
        </span>
      </button>
      <Button variant="ghost" size="icon-sm" aria-label={`Remove ${track.name}`} disabled={disabled} onClick={onRemove}>
        <XIcon />
      </Button>
    </li>
  )
}

function ResultRow({ result, index }: { result: Saved; index: number }) {
  const audio = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [busy, setBusy] = useState(false)
  const id = result.path
  // Browsers can't play AIFF, so those files only offer their folder.
  const playable = !/\.aiff?$/i.test(result.path)

  useEffect(() => {
    const onPlay = (event: Event) => {
      if (event instanceof CustomEvent && event.detail !== id) audio.current?.pause()
    }
    window.addEventListener("track-play", onPlay)
    return () => {
      window.removeEventListener("track-play", onPlay)
      const node = audio.current
      if (node) {
        node.pause()
        URL.revokeObjectURL(node.src)
      }
    }
  }, [id])

  async function toggle() {
    if (audio.current && !audio.current.paused) {
      audio.current.pause()
      return
    }
    try {
      if (!audio.current) {
        if (!ox.available()) throw new Error("Reopen this app in 0x1audio.")
        setBusy(true)
        const bytes = await ox.files.read(result.path)
        const node = new Audio(URL.createObjectURL(new Blob([bytes.slice()])))
        node.onplay = () => setPlaying(true)
        node.onpause = () => setPlaying(false)
        node.onended = () => setPlaying(false)
        audio.current = node
      }
      window.dispatchEvent(new CustomEvent("track-play", { detail: id }))
      await audio.current.play()
    } catch (error) {
      toast.error(problem(error, "This file can't be played here."), { description: "Show it in its folder to open it." })
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="flex h-12 items-center gap-3 rounded-lg pr-1.5 pl-3 hover:bg-hover" style={{ "--i": index } as CSSProperties}>
      <CheckCircleIcon size={16} weight="fill" className="shrink-0 text-success" />
      <span className="min-w-0 flex-1 truncate text-sm">{result.name}</span>
      {playable ? (
        <Button variant="ghost" size="icon-sm" aria-label={playing ? `Pause ${result.name}` : `Play ${result.name}`} disabled={busy} onClick={() => void toggle()}>
          {busy ? <Spinner /> : playing ? <PauseIcon weight="fill" /> : <PlayIcon weight="fill" />}
        </Button>
      ) : null}
      <Button variant="ghost" size="sm" onClick={() => void ox.files.reveal(result.path)}>
        <FolderOpenIcon />
        Show in folder
      </Button>
    </li>
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
    <PageSection
      className="py-0"
      title="Change"
      description="You hear every change as it plays."
      actions={
        <Button
          variant="ghost"
          size="sm"
          className="-my-2 -mr-2.5"
          disabled={disabled || !changed}
          onClick={() => onChange({ pitch: 0, formant: 0, targetBpm: track.sourceBpm })}
        >
          <ArrowCounterClockwiseIcon />
          Reset
        </Button>
      }
    >
      <div className="flex flex-col gap-6 rounded-2xl bg-card p-5">
        <Semitones label="Pitch" hint="Moves the notes." value={track.pitch} min={-24} max={24} disabled={disabled} onChange={(pitch) => onChange({ pitch })} />
        <Semitones
          label="Formant"
          hint="Makes a voice sound bigger or smaller."
          value={track.formant}
          min={-12}
          max={12}
          disabled={disabled}
          onChange={(formant) => onChange({ formant })}
        />

        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
            <div className="flex flex-col gap-2">
              <Label htmlFor="source-bpm">Original BPM</Label>
              <div className="flex gap-2">
                <Input
                  id="source-bpm"
                  type="number"
                  inputMode="decimal"
                  min={20}
                  max={400}
                  step={0.01}
                  placeholder="Unknown"
                  className="tabular-nums"
                  value={track.sourceBpm}
                  disabled={disabled}
                  onChange={(event) => onChange({ sourceBpm: event.target.value })}
                />
                <Button variant="outline" className="px-3" aria-label="Half the original BPM" disabled={disabled || !track.sourceBpm} onClick={() => scaleSource(0.5)}>
                  ½×
                </Button>
                <Button variant="outline" className="px-3" aria-label="Double the original BPM" disabled={disabled || !track.sourceBpm} onClick={() => scaleSource(2)}>
                  2×
                </Button>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="target-bpm">New BPM</Label>
              <Input
                id="target-bpm"
                type="number"
                inputMode="decimal"
                min={20}
                max={400}
                step={0.01}
                placeholder={track.sourceBpm ? track.sourceBpm : "Set the original first"}
                className="tabular-nums"
                aria-invalid={!settings || undefined}
                value={track.targetBpm}
                disabled={disabled || !track.sourceBpm}
                onChange={(event) => onChange({ targetBpm: event.target.value })}
              />
            </div>
          </div>
          <p className={cn("text-[13px]", settings ? "text-muted-foreground" : "text-destructive")}>
            {!settings
              ? "Keep the new BPM between a quarter and four times the original."
              : [
                  track.opened?.bpm ? `Found ${track.opened.bpm} BPM.` : "No clear beat found. Type the BPM if you know it.",
                  settings.tempo !== 1 ? `Plays at ${Math.round(settings.tempo * 1000) / 10}% speed.` : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
          </p>
        </div>
      </div>
    </PageSection>
  )
}

function EditorSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-6 rounded-2xl bg-card p-5">
      {[0, 1].map((index) => (
        <div key={index} className="flex flex-col gap-3">
          <div className="flex justify-between">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-24" />
          </div>
          <Skeleton className="h-1.5 w-full rounded-full" />
        </div>
      ))}
      <div className="grid grid-cols-2 gap-4">
        <Skeleton className="h-9" />
        <Skeleton className="h-9" />
      </div>
    </div>
  )
}

function Semitones({
  label,
  hint,
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  label: string
  hint: string
  value: number
  min: number
  max: number
  disabled: boolean
  onChange: (value: number) => void
}) {
  const shown = value === 0 ? "0" : `${value > 0 ? "+" : "−"}${Math.abs(value)}`
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-4">
        <p className="flex items-baseline gap-2">
          <span className="text-sm font-medium">{label}</span>
          <span className="text-[13px] text-muted-foreground max-sm:hidden">{hint}</span>
        </p>
        <span className="text-sm text-muted-foreground tabular-nums">
          {shown} {Math.abs(value) === 1 ? "semitone" : "semitones"}
        </span>
      </div>
      <Slider
        className="data-disabled:opacity-50"
        aria-label={label}
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
  if (track.error) return "Couldn't be opened"
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
