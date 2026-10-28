// End-to-end check of bridge + scraper without Chrome or Claude: bun tools/smoke.ts
import { connect } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { Window } from 'happy-dom'
import { extractTeams } from '../extension/src/scrapers/teams'
import type { CaptionUpdate, Status } from '../shared/types'

const PORT = 18789 // the tests use 18787/18788
const BASE = `http://127.0.0.1:${PORT}`
const ROOT = new URL('..', import.meta.url).pathname

let failed = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `  (${detail})` : ''}`)
  return ok
}

async function until<T>(get: () => T | undefined | Promise<T | undefined>, ms: number): Promise<T | undefined> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const v = await get()
    if (v !== undefined) return v
    await Bun.sleep(25)
  }
}

// Raw socket, because fetch controls Host and (in browsers) Origin; the guard must be tested with exactly these headers.
function rawStatus(method: string, path: string, headers: Record<string, string>, body = ''): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = connect(PORT, '127.0.0.1', () => {
      const lines = Object.entries({ ...headers, 'Content-Length': String(body.length), Connection: 'close' }).map(([k, v]) => `${k}: ${v}`)
      sock.write(`${method} ${path} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n${body}`)
    })
    let data = ''
    sock.on('data', (c) => (data += c))
    sock.on('error', reject)
    sock.on('close', () => resolve(Number(data.match(/^HTTP\/1\.1 (\d+)/)?.[1] ?? 0)))
  })
}

const post = (path: string, body?: unknown) =>
  fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
const getStatus = async () => (await fetch(`${BASE}/status`)).json() as Promise<Status>

type Note = { method: string; params?: { content?: string; meta?: Record<string, string> } }
const notes: Note[] = []
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['bridge/server.ts'],
  cwd: ROOT,
  env: { ...process.env, BRIDGE_PORT: String(PORT) } as Record<string, string>,
})
const client = new Client({ name: 'smoke', version: '0.0.0' })
client.fallbackNotificationHandler = async (n) => void notes.push(n as Note)
const nextNote = (kind: string) => until(() => notes.find((n) => n.params?.meta?.kind === kind && !seen.has(n)), 8000)
const seen = new Set<Note>()
const ack = async (n: Note) => {
  seen.add(n)
  await client.callTool({ name: 'ack', arguments: { event_id: n.params!.meta!.event_id } })
}

try {
  await client.connect(transport)

  // 1. channel liveness: the bridge's self-test arrives and is answered through the ack tool
  const selftest = await nextNote('selftest')
  check('self-test notification arrives', !!selftest)
  if (selftest) await ack(selftest)
  check('ack of the self-test marks the channel loaded', (await getStatus()).channelLoaded === true)

  // 2. replay the recorded Teams captions through the real scraper into the real bridge
  const fixture: { selfName: string; snapshots: { html: string }[] } = await Bun.file(new URL('../extension/fixtures/teams.json', import.meta.url)).json()
  const doc = new Window().document as unknown as Document
  const lastText = new Map<string, CaptionUpdate>()
  let posted = 0
  let rejected = 0
  for (const { html } of fixture.snapshots) {
    doc.body.innerHTML = html
    for (const u of extractTeams(doc.body, [fixture.selfName], Date.now())) {
      const res = await post('/caption', u)
      res.status === 204 ? posted++ : rejected++
      lastText.set(u.blockId, u)
    }
  }
  check('every scraped update is accepted by /caption', posted > 0 && rejected === 0, `posted ${posted}, rejected ${rejected}`)
  check('/status sees captions arriving', typeof (await getStatus()).lastCaptionAgeMs === 'number')

  // 3. trigger: the question comes out through the channel. The last turn may still be open (1.5 s gap), so retry on in-progress.
  const sent = await until(async () => {
    const res = await post('/trigger')
    if (res.status === 200) return true
    return (await res.json().catch(() => ({}))).reason === 'in-progress' ? undefined : false
  }, 5000)
  check('/trigger returns 200', sent === true)
  const question = await nextNote('question')
  check('a question notification arrives', !!question)
  if (question) {
    const body = question.params?.content ?? ''
    const asked = body.split('\n').slice(1, body.split('\n').indexOf('----- INTERVIEWER QUESTION (end) -----')).join('\n')
    const said = (speaker: string) => [...lastText.values()].filter((u) => u.speaker === speaker && u.text)
    check('it carries an interviewer turn from the fixture', said('interviewer').some((u) => asked.includes(u.text)), asked)
    check('the question holds no user speech', !said('user').some((u) => asked.includes(u.text)), asked)
    check('pendingAck is true until the model acks', (await getStatus()).pendingAck === true)
    await ack(question)
    check('ack of the question clears pendingAck', (await getStatus()).pendingAck === false)
  }

  // 4. the browser-origin guard, with real requests
  const host = `127.0.0.1:${PORT}`
  check('chrome-extension Origin is allowed', (await rawStatus('GET', '/status', { Host: host, Origin: 'chrome-extension://abcdefghijklmnop' })) === 200)
  check('no Origin is allowed', (await rawStatus('GET', '/status', { Host: host })) === 200)
  check('web Origin on /caption is refused', (await rawStatus('POST', '/caption', { Host: host, Origin: 'https://teams.microsoft.com' }, '{}')) === 403)
  check('wrong Host is refused', (await rawStatus('GET', '/status', { Host: 'evil.example' })) === 403)
} catch (err) {
  check('smoke run completed without throwing', false, String(err))
} finally {
  await client.close().catch(() => {})
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed')
process.exit(failed ? 1 : 0)
