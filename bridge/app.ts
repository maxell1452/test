import type { CaptionUpdate, Snapshot, Status, TriggerResult } from '../shared/types'
import { buildQuestionEvent, buildSelfTestEvent, type ChannelEvent } from './channel'
import type { TurnBuffer } from './turns'

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
  Number.isFinite(v.ts)

export function createApp(deps: {
  buffer: TurnBuffer
  emit: (e: ChannelEvent) => Promise<void>
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
  const { buffer, emit, now, newId, port } = deps
  const debounceMs = deps.debounceMs ?? 1500
  let autoFire = false
  let channelLoaded = false
  let lastEmittedId: string | null = null
  let pendingAck = false
  let lastSent: { startedAt: number; at: number } | null = null

  // Emit first, record state only on success, so a failed emit can be retried at once.
  async function send(event: ChannelEvent): Promise<void> {
    await emit(event)
    lastEmittedId = event.meta.event_id
    pendingAck = true
  }

  async function fire(): Promise<TriggerResult> {
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
        case 'POST /auto': {
          const b = await body(req)
          if (!isObj(b) || typeof b.on !== 'boolean') return bad()
          autoFire = b.on
          return noContent()
        }
        case 'POST /reset':
          buffer.clear()
          return noContent()
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
