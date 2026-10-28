declare module "signalsmith-stretch" {
  export interface StretchSchedule {
    active?: boolean
    input?: number
    output?: number
    rate?: number
    semitones?: number
    formantSemitones?: number
    formantCompensation?: boolean
    formantBaseHz?: number
    tonalityHz?: number
  }

  export interface StretchNode extends AudioWorkletNode {
    inputTime: number
    schedule(change: StretchSchedule): Promise<unknown>
    addBuffers(channels: Float32Array[]): Promise<number>
    setUpdateInterval(seconds: number, callback?: (inputTime: number) => void): Promise<unknown>
  }

  export default function SignalsmithStretch(context: BaseAudioContext, options?: AudioWorkletNodeOptions): Promise<StretchNode>
}
