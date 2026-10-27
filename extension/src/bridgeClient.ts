import type { CaptionUpdate, Status } from '../../shared/types'

export type BridgeState = 'sent' | 'waiting' | 'no-question' | 'no-captions' | 'duplicate' | 'down' | 'no-ack'

const JSON_POST = { method: 'POST', headers: { 'content-type': 'application/json' } }

export function createBridgeClient(fetchFn: typeof fetch, base = 'http://127.0.0.1:8787') {
  const root = base.replace(/\/+$/, '')

  // Fire-and-forget: a dead or unhappy bridge must never throw into callers.
  const post = async (path: string, body?: unknown): Promise<void> => {
    try {
      await fetchFn(`${root}${path}`, body === undefined ? { method: 'POST' } : { ...JSON_POST, body: JSON.stringify(body) })
    } catch {}
  }

  const status = async (): Promise<Status | null> => {
    try {
      const res = await fetchFn(`${root}/status`)
      return res.ok ? ((await res.json()) as Status) : null
    } catch {
      return null
    }
  }

  const trigger = async (): Promise<BridgeState> => {
    try {
      const res = await fetchFn(`${root}/trigger`, { method: 'POST' })
      if (res.status === 200) return 'sent'
      if (res.status !== 409) return 'down'
      const reason = ((await res.json()) as { reason?: unknown }).reason
      if (reason === 'in-progress') return 'waiting'
      if (reason === 'duplicate') return 'duplicate'
      if (reason !== 'no-question') return 'down'
      return (await status())?.lastCaptionAgeMs === null ? 'no-captions' : 'no-question'
    } catch {
      return 'down'
    }
  }

  return {
    postCaption: (u: CaptionUpdate) => post('/caption', u),
    trigger,
    setAuto: (on: boolean) => post('/auto', { on }),
    reset: () => post('/reset'),
    status,
  }
}
