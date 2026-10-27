import { describe, expect, test } from 'bun:test'
import { createBridgeClient } from './bridgeClient'
import type { CaptionUpdate, Status } from '../../shared/types'

type Call = { url: string; init?: RequestInit }
type Responder = (url: string, init?: RequestInit) => Response | Promise<Response>

const stub = (respond: Responder) => {
  const calls: Call[] = []
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    return respond(url, init)
  }) as unknown as typeof fetch
  return { fetchFn, calls }
}
const rejecting = () => stub(() => Promise.reject(new TypeError('connection refused')))
const status = (lastCaptionAgeMs: number | null): Status => ({
  autoFire: false,
  channelLoaded: true,
  pendingAck: false,
  lastCaptionAgeMs,
})
const conflict = (reason: string) => Response.json({ sent: false, reason }, { status: 409 })
const BASE = 'http://127.0.0.1:8787'

describe('trigger', () => {
  test("returns 'down' when fetch rejects", async () => {
    const { fetchFn, calls } = rejecting()
    expect(await createBridgeClient(fetchFn).trigger()).toBe('down')
    expect(calls.map((c) => c.url)).toEqual([`${BASE}/trigger`])
  })

  test("maps 200 to 'sent'", async () => {
    const { fetchFn, calls } = stub(() => Response.json({ sent: true, eventId: 'e1' }))
    expect(await createBridgeClient(fetchFn).trigger()).toBe('sent')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${BASE}/trigger`)
    expect(calls[0]!.init?.method).toBe('POST')
  })

  test("maps 409 in-progress to 'waiting'", async () => {
    const { fetchFn } = stub(() => conflict('in-progress'))
    expect(await createBridgeClient(fetchFn).trigger()).toBe('waiting')
  })

  test("maps 409 duplicate to 'duplicate'", async () => {
    const { fetchFn } = stub(() => conflict('duplicate'))
    expect(await createBridgeClient(fetchFn).trigger()).toBe('duplicate')
  })

  test("409 no-question maps to 'no-captions' when status().lastCaptionAgeMs is null", async () => {
    const { fetchFn, calls } = stub((url) => (url.endsWith('/status') ? Response.json(status(null)) : conflict('no-question')))
    expect(await createBridgeClient(fetchFn).trigger()).toBe('no-captions')
    expect(calls.map((c) => `${c.init?.method ?? 'GET'} ${c.url}`)).toEqual([`POST ${BASE}/trigger`, `GET ${BASE}/status`])
  })

  test("409 no-question maps to 'no-question' when captions have been seen", async () => {
    const { fetchFn, calls } = stub((url) => (url.endsWith('/status') ? Response.json(status(1200)) : conflict('no-question')))
    expect(await createBridgeClient(fetchFn).trigger()).toBe('no-question')
    expect(calls).toHaveLength(2)
  })

  test("409 no-question maps to 'no-question' when status() is unavailable", async () => {
    const { fetchFn } = stub((url) => (url.endsWith('/status') ? new Response('boom', { status: 500 }) : conflict('no-question')))
    expect(await createBridgeClient(fetchFn).trigger()).toBe('no-question')
  })

  test("returns 'down' on a 500", async () => {
    const { fetchFn } = stub(() => new Response('emit failed', { status: 500 }))
    expect(await createBridgeClient(fetchFn).trigger()).toBe('down')
  })

  test("returns 'down' on a 403", async () => {
    const { fetchFn } = stub(() => new Response('forbidden', { status: 403 }))
    expect(await createBridgeClient(fetchFn).trigger()).toBe('down')
  })

  test("returns 'down' on an unparsable 409 body", async () => {
    const { fetchFn } = stub(() => new Response('<html>not json</html>', { status: 409 }))
    expect(await createBridgeClient(fetchFn).trigger()).toBe('down')
  })

  test("returns 'down' on a 409 with an unknown reason", async () => {
    const { fetchFn } = stub(() => conflict('mystery'))
    expect(await createBridgeClient(fetchFn).trigger()).toBe('down')
  })
})

describe('status', () => {
  test('returns the parsed Status and GETs /status', async () => {
    const s = status(5)
    const { fetchFn, calls } = stub(() => Response.json(s))
    expect(await createBridgeClient(fetchFn).status()).toEqual(s)
    expect(calls[0]!.url).toBe(`${BASE}/status`)
    expect(calls[0]!.init?.method ?? 'GET').toBe('GET')
  })

  test('returns null when fetch rejects', async () => {
    expect(await createBridgeClient(rejecting().fetchFn).status()).toBeNull()
  })

  test('returns null on a non-OK response', async () => {
    const { fetchFn } = stub(() => new Response('nope', { status: 500 }))
    expect(await createBridgeClient(fetchFn).status()).toBeNull()
  })

  test('returns null on an unparsable body', async () => {
    const { fetchFn } = stub(() => new Response('not json', { status: 200 }))
    expect(await createBridgeClient(fetchFn).status()).toBeNull()
  })
})

describe('fire-and-forget calls', () => {
  const update: CaptionUpdate = { blockId: 'b1', speaker: 'interviewer', speakerName: 'Sam', text: 'Hi there', ts: 42 }

  test('postCaption sends the update as JSON to /caption', async () => {
    const { fetchFn, calls } = stub(() => new Response(null, { status: 204 }))
    await createBridgeClient(fetchFn).postCaption(update)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${BASE}/caption`)
    expect(calls[0]!.init?.method).toBe('POST')
    expect(new Headers(calls[0]!.init?.headers).get('content-type')).toBe('application/json')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual(update)
  })

  test('postCaption swallows a rejected fetch', async () => {
    const { fetchFn, calls } = rejecting()
    await createBridgeClient(fetchFn).postCaption(update)
    expect(calls).toHaveLength(1)
  })

  test('postCaption swallows a non-OK response', async () => {
    const { fetchFn } = stub(() => new Response('bad request', { status: 400 }))
    await createBridgeClient(fetchFn).postCaption(update)
  })

  test('setAuto sends {on:true} as JSON to /auto', async () => {
    const { fetchFn, calls } = stub(() => new Response(null, { status: 204 }))
    await createBridgeClient(fetchFn).setAuto(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${BASE}/auto`)
    expect(calls[0]!.init?.method).toBe('POST')
    expect(new Headers(calls[0]!.init?.headers).get('content-type')).toBe('application/json')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ on: true })
  })

  test('setAuto sends {on:false}', async () => {
    const { fetchFn, calls } = stub(() => new Response(null, { status: 204 }))
    await createBridgeClient(fetchFn).setAuto(false)
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ on: false })
  })

  test('reset POSTs to /reset', async () => {
    const { fetchFn, calls } = stub(() => new Response(null, { status: 204 }))
    await createBridgeClient(fetchFn).reset()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${BASE}/reset`)
    expect(calls[0]!.init?.method).toBe('POST')
  })

  test('reset and setAuto swallow rejected fetches', async () => {
    const { fetchFn, calls } = rejecting()
    const c = createBridgeClient(fetchFn)
    await c.reset()
    await c.setAuto(true)
    expect(calls.map((x) => x.url)).toEqual([`${BASE}/reset`, `${BASE}/auto`])
  })

  test('reset and setAuto swallow non-OK responses', async () => {
    const { fetchFn } = stub(() => new Response('forbidden', { status: 403 }))
    const c = createBridgeClient(fetchFn)
    await c.reset()
    await c.setAuto(false)
  })
})

describe('base url', () => {
  test('a trailing slash on base does not produce a double slash', async () => {
    const { fetchFn, calls } = stub(() => Response.json(status(null)))
    await createBridgeClient(fetchFn, 'http://127.0.0.1:9999/').status()
    expect(calls[0]!.url).toBe('http://127.0.0.1:9999/status')
  })
})
