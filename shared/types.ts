export type Speaker = 'interviewer' | 'user'

/** `text` is the block's full current text; the same `blockId` is re-sent as it grows or is corrected. */
export interface CaptionUpdate {
  blockId: string
  speaker: Speaker
  speakerName: string
  text: string
  ts: number
  /** Browser tab the caption came from; set by the service worker, never by the page. Absent = tab 0. */
  tabId?: number
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

/** `png` is bare base64 (no `data:` prefix). Everything here comes from the page and is untrusted. */
export interface CapturePayload {
  url: string
  title: string
  text: string
  png: string
}
