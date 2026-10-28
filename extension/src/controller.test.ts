import { describe, expect, test } from 'bun:test'
import { createController } from './controller'
import type { BridgeState } from './bridgeClient'
import type { CaptionUpdate, Status } from '../../shared/types'

const update = (blockId = 'b1'): CaptionUpdate => ({ blockId, speaker: 'interviewer', speakerName: 'Sam', text: 'hi', ts: 1 })
const status = (over: Partial<Status> = {}): Status => ({
  autoFire: false,
  channelLoaded: true,
  pendingAck: false,
  lastCaptionAgeMs: 0,
  ...over,
})

function setup(opts: { trigger?: BridgeState; status?: Status | null; tabs?: number[] } = {}) {
  const calls: string[] = []
  const badges: unknown[] = []
  const scheduled: { fn: () => void; ms: number }[] = []
  let tabs = opts.tabs ?? []
  let writes = 0
  let current = opts.status === undefined ? status() : opts.status
  const client = {
    postCaption: async (u: CaptionUpdate) => void calls.push(`caption:${u.blockId}`),
    trigger: async () => opts.trigger ?? 'sent',
    setAuto: async (on: boolean) => void calls.push(`auto:${on}`),
    reset: async () => void calls.push('reset'),
    status: async () => current,
  }
  const deps = {
    client,
    setBadge: (s: unknown) => void badges.push(s),
    storage: {
      getTabs: async () => [...tabs],
      setTabs: async (t: number[]) => {
        writes++
        tabs = [...t]
      },
    },
    schedule: (fn: () => void, ms: number) => void scheduled.push({ fn, ms }),
  }
  return {
    deps,
    calls,
    badges,
    scheduled,
    writes: () => writes,
    setStatus: (s: Status | null) => (current = s),
    controller: createController(deps),
  }
}

describe('onTrigger', () => {
  test("'sent' sets the badge, then 'no-ack' once the check finds pendingAck", async () => {
    const t = setup()
    await t.controller.onTrigger()
    expect(t.badges).toEqual(['sent'])
    expect(t.scheduled.map((s) => s.ms)).toEqual([10_000])
    t.setStatus(status({ pendingAck: true }))
    await t.scheduled[0].fn()
    expect(t.badges).toEqual(['sent', 'no-ack'])
  })

  test('no badge change when the question was acked in time', async () => {
    const t = setup()
    await t.controller.onTrigger()
    t.setStatus(status({ pendingAck: false }))
    await t.scheduled[0].fn()
    expect(t.badges).toEqual(['sent'])
  })

  test('an unreachable bridge at check time does not flag no-ack', async () => {
    const t = setup()
    await t.controller.onTrigger()
    t.setStatus(null)
    await t.scheduled[0].fn()
    expect(t.badges).toEqual(['sent'])
  })

  test("'down' sets the badge and schedules nothing; ackTimeoutMs is honoured", async () => {
    const down = setup({ trigger: 'down' })
    await down.controller.onTrigger()
    expect(down.badges).toEqual(['down'])
    expect(down.scheduled).toEqual([])

    const t = setup()
    const c = createController({ ...t.deps, ackTimeoutMs: 50 })
    await c.onTrigger()
    expect(t.scheduled.map((s) => s.ms)).toEqual([50])
  })
})

describe('onToggleAuto', () => {
  test('flips on then off, seeded from the bridge status', async () => {
    const t = setup()
    await t.controller.onToggleAuto()
    await t.controller.onToggleAuto()
    expect(t.calls).toEqual(['auto:true', 'auto:false'])
    expect(t.badges).toEqual(['auto-on', 'auto-off'])
  })

  test('starts from the bridge autoFire when it is already on', async () => {
    const t = setup({ status: status({ autoFire: true }) })
    await t.controller.onToggleAuto()
    expect(t.calls).toEqual(['auto:false'])
    expect(t.badges).toEqual(['auto-off'])
  })
})

describe('onToggleAuto, bridge down', () => {
  test("shows 'down' and changes nothing when the first status read fails", async () => {
    const t = setup({ status: null })
    await t.controller.onToggleAuto()
    expect(t.calls).toEqual([])
    expect(t.badges).toEqual(['down'])
  })
})

describe('tabs', () => {
  test('onCaption posts every update but writes storage once per tab id', async () => {
    const t = setup()
    await t.controller.onCaption(7, update('a'))
    await t.controller.onCaption(7, update('b'))
    await t.controller.onCaption(8, update('c'))
    expect(t.calls).toEqual(['caption:a', 'caption:b', 'caption:c'])
    expect(t.writes()).toBe(2)
  })

  test('removal resets only for a tab that sent captions, and only once', async () => {
    const t = setup()
    await t.controller.onCaption(7, update())
    await t.controller.onTabRemoved(99)
    expect(t.calls).not.toContain('reset')
    await t.controller.onTabRemoved(7)
    await t.controller.onTabRemoved(7)
    expect(t.calls.filter((c) => c === 'reset')).toHaveLength(1)
  })

  test('a new controller over the same storage still resets (service worker restart)', async () => {
    const t = setup()
    await t.controller.onCaption(7, update())
    const reborn = createController(t.deps)
    await reborn.onTabRemoved(7)
    expect(t.calls).toContain('reset')
  })
})
