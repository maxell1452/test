import type { CaptionUpdate, CapturePayload, Snapshot, Status, TriggerResult } from '../shared/types'
import { buildCaptureEvent, buildQuestionEvent, buildSelfTestEvent, type ChannelEvent } from './channel'
import type { TurnBuffer } from './turns'

// What the app needs from a buffer: a single TurnBuffer (tests) or TabBuffers (server).
type Buffer = Pick<TurnBuffer, 'ingest' | 'snapshot' | 'tick' | 'lastCaptionAgeMs'> & {
  clear(tab?: number): void
  focus?(tab: number): void
}

const json = (body: unknown, status = 200) => Response.json(body, { status })
const noContent = () => new Response(null, { status: 204 })
const bad = () => new Response('bad request', { status: 400 })

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isCaption = (v: unknown): v is CaptionUpdate =>
  isObj(v) &&
  typeof v.blockId === 'string' &&
  (v.speaker === 'interviewer' || v.speaker === 'user') &&
  typeof v.speakerName === 'string' &&
  typeof v.text === 'string' &&
  typeof v.ts === 'number' &&
  Number.isFinite(v.ts) &&
  (v.tabId === undefined || (typeof v.tabId === 'number' && Number.isFinite(v.tabId)))

const isCapturePayload = (v: unknown): v is CapturePayload =>
  isObj(v) &&
  typeof v.url === 'string' &&
  typeof v.title === 'string' &&
  typeof v.text === 'string' &&
  typeof v.png === 'string'

export function createApp(deps: {
  buffer: Buffer
  emit: (e: ChannelEvent) => Promise<void>
  writeCapture: (id: string, png: Uint8Array, text: string) => Promise<string>
  now: () => number
  newId: () => string
  debounceMs?: number
  port: number
}): {
  fetch(req: Request): Promise<Response>
  tick(): Promise<void>
  ack(eventId: string): void
  selfTest(): Promise<void>
} {
  const { buffer, emit, writeCapture, now, newId, port } = deps
  const debounceMs = deps.debounceMs ?? 1500
  let autoFire = false
  let channelLoaded = false
  let lastEmittedId: string | null = null
  let pendingAck = false
  let lastSent: { startedAt: number; at: number } | null = null
  let firing = false // a fire() is awaiting emit; a concurrent one counts as a duplicate

  // Emit first, record state only on success, so a failed emit can be retried at once.
  async function send(event: ChannelEvent): Promise<void> {
    await emit(event)
    lastEmittedId = event.meta.event_id
    pendingAck = true
  }

  async function fire(): Promise<TriggerResult> {
    if (firing) return { sent: false, reason: 'duplicate' }
    firing = true
    try {
      return await doFire()
    } finally {
      firing = false
    }
  }

  async function doFire(): Promise<TriggerResult> {
    const r = buffer.snapshot()
    if (!('snapshot' in r)) return { sent: false, reason: r.reason }
    const s: Snapshot = r.snapshot
    if (s.question.text.trim() === '') return { sent: false, reason: 'no-question' }
    if (lastSent && lastSent.startedAt === s.question.startedAt && now() - lastSent.at < debounceMs) {
      return { sent: false, reason: 'duplicate' }
    }
    const eventId = newId()
    await send(buildQuestionEvent(s, eventId))
    lastSent = { startedAt: s.question.startedAt, at: now() }
    return { sent: true, eventId }
  }

  const status = (): Status => ({ autoFire, channelLoaded, pendingAck, lastCaptionAgeMs: buffer.lastCaptionAgeMs() })

  async function body(req: Request): Promise<unknown> {
    try {
      return await req.json()
    } catch {
      return undefined
    }
  }

  return {
    async fetch(req) {
      // Guard first: any web page can hit localhost, and caption text reaches Claude (prompt injection).
      const origin = req.headers.get('origin')
      if (origin !== null && !origin.startsWith('chrome-extension://')) return new Response('forbidden', { status: 403 })
      const host = req.headers.get('host') ?? new URL(req.url).host
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return new Response('forbidden', { status: 403 })

      switch (`${req.method} ${new URL(req.url).pathname}`) {
        case 'POST /caption': {
          const b = await body(req)
          if (!isCaption(b)) return bad()
          buffer.ingest(b)
          return noContent()
        }
        case 'POST /trigger': {
          let result: TriggerResult
          try {
            result = await fire()
          } catch {
            return new Response('emit failed', { status: 500 })
          }
          return json(result, result.sent ? 200 : 409)
        }
        case 'POST /capture': {
          const b = await body(req)
          if (!isCapturePayload(b)) return bad()
          const png = Buffer.from(b.png, 'base64')
          if (png.length === 0) return bad()
          const eventId = newId()
          try {
            const dir = await writeCapture(eventId, png, b.text)
            await send(buildCaptureEvent(b, dir, eventId))
          } catch {
            return new Response('emit failed', { status: 500 })
          }
          return json({ sent: true, eventId })
        }
        case 'POST /auto': {
          const b = await body(req)
          if (!isObj(b) || typeof b.on !== 'boolean') return bad()
          autoFire = b.on
          return noContent()
        }
        case 'POST /focus': {
          const b = await body(req)
          if (!isObj(b) || typeof b.tabId !== 'number' || !Number.isFinite(b.tabId)) return bad()
          buffer.focus?.(b.tabId)
          return noContent()
        }
        case 'POST /reset': {
          const b = await body(req) // optional {tabId}: reset one meeting, not all of them
          buffer.clear(isObj(b) && typeof b.tabId === 'number' ? b.tabId : undefined)
          return noContent()
        }
        case 'GET /status':
          return json(status())
        default:
          return new Response('not found', { status: 404 })
      }
    },

    async tick() {
      // Always drain, so enabling auto later never answers old turns.
      // Accepted limitation: a block rewritten after tick() returned its turn is not re-sent.
      const drained = buffer.tick()
      if (!autoFire || !drained.some((t) => t.speaker === 'interviewer' && t.text.trim() !== '')) return
      try {
        await fire()
      } catch (err) {
        console.error('auto-fire emit failed', err)
      }
    },

    ack(eventId) {
      channelLoaded = true
      if (eventId === lastEmittedId) pendingAck = false
    },

    async selfTest() {
      await send(buildSelfTestEvent(newId()))
    },
  }
}
