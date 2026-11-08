import { ox, type Exported } from "@0x1audio/sdk/page"

import type { Change, Samples } from "./engine.ts"

// The app's two actions decode and encode files. Samples go both ways through the
// app's data folder as raw float32, one whole channel after another.

export interface Opened {
  samples: string
  codec: string
  rate: number
  channels: number
  frames: number
  bpm: number | null
  peaks: number[]
}

export interface Saved {
  path: string
  name: string
}

export function open(path: string) {
  return ox.run<Opened>("open_audio", { path })
}

export async function load(track: Opened): Promise<Samples> {
  const bytes = await ox.data.read(track.samples)
  const size = track.channels * track.frames
  if (bytes.byteLength < size * 4) throw new Error("This file changed. Remove it and add it again.")
  const aligned = bytes.byteOffset % 4 === 0 ? bytes : bytes.slice()
  const all = new Float32Array(aligned.buffer, aligned.byteOffset, size)
  return {
    rate: track.rate,
    channels: Array.from({ length: track.channels }, (_, index) => all.subarray(index * track.frames, (index + 1) * track.frames)),
  }
}

let renders = 0

export async function save(
  channels: Float32Array[],
  details: Change & { rate: number; source: string; format: string; output: string; bpm: number | null },
) {
  const frames = channels[0].length
  const all = new Float32Array(frames * channels.length)
  channels.forEach((channel, index) => all.set(channel, index * frames))
  const samples = `renders/${Date.now()}-${(renders += 1)}.f32`
  await ox.data.write(samples, new Uint8Array(all.buffer))
  const { output, ...rest } = details
  const saved = await ox.run<{ items: Exported[] }>("save", { ...rest, output: output || null, samples, channels: channels.length })
  const path = saved.items[0]?.path ?? ""
  return { path, name: path.split(/[/\\]/).pop() ?? path } satisfies Saved
}
