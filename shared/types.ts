export type Speaker = 'interviewer' | 'user'

/** `text` is the block's full current text; the same `blockId` is re-sent as it grows or is corrected. */
export interface CaptionUpdate {
  blockId: string
  speaker: Speaker
  speakerName: string
  text: string
  ts: number
}

export interface Turn {
  speaker: Speaker
  text: string
  startedAt: number
  endedAt: number
}

export interface Snapshot {
  question: Turn
  priorAnswer: Turn | null
}

export type TriggerResult =
  | { sent: true; eventId: string }
  | { sent: false; reason: 'no-question' | 'in-progress' | 'duplicate' }

export interface Status {
  autoFire: boolean
  channelLoaded: boolean
  pendingAck: boolean
  lastCaptionAgeMs: number | null
}
