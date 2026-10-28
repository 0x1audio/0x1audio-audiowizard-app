import SignalsmithStretch, { type StretchNode } from "signalsmith-stretch"

// Pitch, formant, and tempo all run through one Signalsmith Stretch node, live
// while playing and offline for export, so the file sounds like what you heard.

export interface Change {
  pitch: number
  formant: number
  tempo: number
}

export interface Samples {
  rate: number
  channels: Float32Array[]
}

export const unchanged: Change = { pitch: 0, formant: 0, tempo: 1 }

// A fixed formant base. Signalsmith's pitch tracking (0) can lose high voices and
// move the notes along with the formants; 120 Hz held up from 100 to 330 Hz voices.
function settings({ pitch, formant, tempo }: Change) {
  return { rate: tempo, semitones: pitch, formantSemitones: formant, formantCompensation: true, formantBaseHz: 120 }
}

async function stretcher(context: BaseAudioContext, audio: Samples) {
  // The worklet reads its first input even when paused, so it needs one, left unconnected.
  const node = await SignalsmithStretch(context, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [audio.channels.length],
  })
  node.connect(context.destination)
  await node.addBuffers(audio.channels)
  return node
}

export class Player {
  readonly duration: number
  playing = false
  time = 0
  private context: AudioContext
  private node: StretchNode
  private listener: () => void = () => {}

  private constructor(context: AudioContext, node: StretchNode, audio: Samples) {
    this.context = context
    this.node = node
    this.duration = audio.channels[0].length / audio.rate
    void node.setUpdateInterval(1 / 30, (time) => {
      this.time = Math.max(0, time)
      if (this.playing && this.time >= this.duration) {
        this.pause()
        this.seek(0)
      }
      this.listener()
    })
  }

  static async open(audio: Samples, change: Change) {
    const context = new AudioContext({ sampleRate: audio.rate })
    const node = await stretcher(context, audio)
    await node.schedule({ active: false, input: 0, ...settings(change) })
    return new Player(context, node, audio)
  }

  listen(listener: () => void) {
    this.listener = listener
  }

  set(change: Change) {
    void this.node.schedule(settings(change))
  }

  play() {
    void this.context.resume()
    if (this.time >= this.duration) this.seek(0)
    this.playing = true
    void this.node.schedule({ active: true })
    this.listener()
  }

  pause() {
    this.playing = false
    void this.node.schedule({ active: false })
    this.listener()
  }

  seek(time: number) {
    this.time = Math.min(Math.max(0, time), this.duration)
    void this.node.schedule({ input: this.time })
    this.listener()
  }

  close() {
    this.listener = () => {}
    void this.context.close()
  }
}

// The stretcher fades in over its first block, so the render starts a little
// before the track and that lead-in is cut off. The first beat stays sharp.
const LEAD_SECONDS = 0.2

export async function render(audio: Samples, change: Change): Promise<Float32Array[]> {
  const lead = Math.round(LEAD_SECONDS * audio.rate)
  const length = Math.max(1, Math.round(audio.channels[0].length / change.tempo))
  const context = new OfflineAudioContext(audio.channels.length, lead + length, audio.rate)
  const node = await stretcher(context, audio)
  await node.schedule({ active: true, input: -LEAD_SECONDS * change.tempo, output: 0, ...settings(change) })
  const result = await context.startRendering()
  return Array.from({ length: result.numberOfChannels }, (_, index) => result.getChannelData(index).subarray(lead))
}
