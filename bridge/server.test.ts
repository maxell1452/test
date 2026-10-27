import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Status } from '../shared/types'

const PORT = 18787
const BASE = `http://127.0.0.1:${PORT}`
const ROOT = new URL('..', import.meta.url).pathname

let client: Client
let transport: StdioClientTransport
let notifications: { method: string; params?: Record<string, unknown> }[]

async function until(cond: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await cond()) return true
    await Bun.sleep(25)
  }
  return false
}

const getStatus = async () => (await fetch(`${BASE}/status`)).json() as Promise<Status>

beforeEach(async () => {
  notifications = []
  transport = new StdioClientTransport({
    command: process.execPath,
    args: ['bridge/server.ts'],
    cwd: ROOT,
    env: { ...process.env, BRIDGE_PORT: String(PORT) } as Record<string, string>,
  })
  client = new Client({ name: 'test', version: '0.0.0' })
  client.fallbackNotificationHandler = async (n) => {
    notifications.push(n as (typeof notifications)[number])
  }
  await client.connect(transport)
})

afterEach(async () => {
  await client.close()
})

describe('bridge server', () => {
  test('declares the channel capability and an ack tool', async () => {
    expect(client.getServerCapabilities()?.experimental?.['claude/channel']).toBeDefined()
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toContain('ack')
  })

  test('serves status over HTTP', async () => {
    const res = await fetch(`${BASE}/status`)
    expect(res.status).toBe(200)
    const s = (await res.json()) as Status
    expect(s.autoFire).toBe(false)
    expect(s.channelLoaded).toBe(false)
    expect(s.lastCaptionAgeMs).toBeNull()
    expect(typeof s.pendingAck).toBe('boolean')
  })

  test('ack tool marks the channel loaded; a missing event_id is an error', async () => {
    const bad = await client.callTool({ name: 'ack', arguments: {} })
    expect(bad.isError).toBe(true)
    expect((await getStatus()).channelLoaded).toBe(false)

    const ok = await client.callTool({ name: 'ack', arguments: { event_id: 'x' } })
    expect(ok.isError).toBeFalsy()
    expect((await getStatus()).channelLoaded).toBe(true)
  })

  test('rejects a foreign Origin over the real HTTP server', async () => {
    const res = await fetch(`${BASE}/caption`, { method: 'POST', headers: { Origin: 'https://evil.example' }, body: '{}' })
    expect(res.status).toBe(403)
  })

  test('emits the self-test channel notification shortly after connect', async () => {
    expect(await until(() => notifications.length > 0, 3000)).toBe(true)
    const n = notifications[0]
    expect(n.method).toBe('notifications/claude/channel')
    expect((n.params?.meta as Record<string, string>).kind).toBe('selftest')
    expect(String(n.params?.content)).toContain('Self-test')
  })

  test('exits when the client disconnects', async () => {
    const pid = transport.pid!
    expect(pid).toBeGreaterThan(0)
    await client.close()
    const gone = await until(() => {
      try {
        process.kill(pid, 0)
        return false
      } catch {
        return true
      }
    }, 2000)
    expect(gone).toBe(true)
    expect(fetch(`${BASE}/status`)).rejects.toThrow()
  })
})
