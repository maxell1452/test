import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from './app'
import { writeCapture } from './capture'
import { INSTRUCTIONS } from './channel'
import { TabBuffers } from './turns'

// stdout is the MCP protocol channel: diagnostics go to console.error only.
const port = Number(process.env.BRIDGE_PORT ?? 8787)

const mcp = new Server(
  { name: 'interview-bridge', version: '0.0.1' },
  { capabilities: { experimental: { 'claude/channel': {} }, tools: {} }, instructions: INSTRUCTIONS },
)

const app = createApp({
  buffer: new TabBuffers({ turnGapMs: 1500, now: Date.now }),
  emit: (e) => mcp.notification({ method: 'notifications/claude/channel', params: { content: e.content, meta: e.meta } }),
  writeCapture: (id, png, text) => writeCapture(join(tmpdir(), 'interview-bridge'), id, png, text),
  now: Date.now,
  newId: () => crypto.randomUUID(),
  port,
})

let loaded = false

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'ack',
      description: 'Acknowledge a channel event after handling it. Pass the event_id from the event tag.',
      inputSchema: { type: 'object', properties: { event_id: { type: 'string' } }, required: ['event_id'] },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true })
  if (req.params.name !== 'ack') return fail(`unknown tool: ${req.params.name}`)
  const id = req.params.arguments?.event_id
  if (typeof id !== 'string') return fail('event_id must be a string')
  app.ack(id)
  loaded = true
  return { content: [{ type: 'text' as const, text: 'ok' }] }
})

const http = Bun.serve({ hostname: '127.0.0.1', port, maxRequestBodySize: 16 * 1024 * 1024, fetch: app.fetch })

const quit = () => {
  void http.stop(true)
  process.exit(0)
}
mcp.onclose = quit
process.stdin.on('end', quit).on('close', quit)
process.on('SIGTERM', quit).on('SIGINT', quit)

await mcp.connect(new StdioServerTransport())

setInterval(() => {
  app.tick().catch((e) => console.error(e))
}, 250).unref()

// Prove the channel is live: up to 3 self-tests, 5 s apart, until the model acks one.
let attempts = 0
const selfTest = () => {
  if (loaded || attempts++ >= 3) return
  app.selfTest().catch((e) => console.error('self-test failed', e))
  setTimeout(selfTest, 5000).unref()
}
setTimeout(selfTest, 1500).unref()
