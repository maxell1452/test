import { describe, expect, spyOn, test } from 'bun:test'
import { createController } from './controller'
import type { BridgeState } from './bridgeClient'
import type { CaptionUpdate, CapturePayload, Status } from '../../shared/types'

const update = (blockId = 'b1'): CaptionUpdate => ({ blockId, speaker: 'interviewer', speakerName: 'Sam', text: 'hi', ts: 1 })
const status = (over: Partial<Status> = {}): Status => ({
  autoFire: false,
  channelLoaded: true,
  pendingAck: false,
  lastCaptionAgeMs: 0,
  ...over,
})

function setup(
  opts: {
    trigger?: BridgeState
    capture?: BridgeState
    status?: Status | null
    tabs?: number[]
    ignoreSetAuto?: boolean // the bridge never applies the post
    dieOnSetAuto?: boolean // the bridge goes away right after the post
    badgeThrows?: boolean // chrome.action missing or failing
    setTabsFails?: number // first n setTabs calls reject
    getTabsDelayMs?: number
  } = {},
) {
  const calls: string[] = []
  const captionTabs: (number | undefined)[] = []
  const badges: unknown[] = []
  const scheduled: { fn: () => void; ms: number }[] = []
  let tabs = opts.tabs ?? []
  let writes = 0
  let failures = opts.setTabsFails ?? 0
  let current = opts.status === undefined ? status() : opts.status
  const client = {
    postCaption: async (u: CaptionUpdate, tabId?: number) => void (calls.push(`caption:${u.blockId}`), captionTabs.push(tabId)),
    focus: async (tabId: number) => void calls.push(`focus:${tabId}`),
    trigger: async () => opts.trigger ?? 'sent',
    capture: async (_p: CapturePayload) => opts.capture ?? 'sent',
    setAuto: async (on: boolean) => {
      calls.push(`auto:${on}`)
      if (opts.dieOnSetAuto) current = null
      else if (current && !opts.ignoreSetAuto) current = { ...current, autoFire: on }
    },
    reset: async (tabId?: number) => void calls.push(`reset:${tabId}`),
    status: async () => current,
  }
  const deps = {
    client,
    setBadge: (s: unknown) => {
      badges.push(s)
      if (opts.badgeThrows) throw new TypeError("Cannot read properties of undefined (reading 'setBadgeText')")
    },
    storage: {
      getTabs: async () => {
        if (opts.getTabsDelayMs) await Bun.sleep(opts.getTabsDelayMs)
        return [...tabs]
      },
      setTabs: async (t: number[]) => {
        if (failures-- > 0) throw new Error('storage quota')
        writes++
        tabs = [...t]
      },
    },
    schedule: (fn: () => void, ms: number) => void scheduled.push({ fn, ms }),
  }
  return {
    deps,
    calls,
    captionTabs,
    badges,
    scheduled,
    writes: () => writes,
    tabs: () => tabs,
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

describe('onToggleAuto, bridge truth', () => {
  test("shows 'down' and changes nothing when the status read fails", async () => {
    const t = setup({ status: null })
    await t.controller.onToggleAuto()
    expect(t.calls).toEqual([])
    expect(t.badges).toEqual(['down'])
  })

  test("bridge down on the second toggle shows 'down', not AUTO", async () => {
    const t = setup()
    await t.controller.onToggleAuto()
    t.setStatus(null)
    await t.controller.onToggleAuto()
    expect(t.calls).toEqual(['auto:true'])
    expect(t.badges).toEqual(['auto-on', 'down'])
  })

  test("bridge gone right after the post shows 'down'", async () => {
    const t = setup({ dieOnSetAuto: true })
    await t.controller.onToggleAuto()
    expect(t.badges).toEqual(['down'])
  })

  test('after a bridge restart the next toggle reads the fresh state, not a stale cache', async () => {
    const t = setup()
    await t.controller.onToggleAuto() // now on
    t.setStatus(status({ autoFire: false })) // bridge restarted, back to off
    await t.controller.onToggleAuto()
    expect(t.calls).toEqual(['auto:true', 'auto:true'])
    expect(t.badges).toEqual(['auto-on', 'auto-on'])
  })

  test('a post the bridge ignores shows the state that is really true', async () => {
    const t = setup({ ignoreSetAuto: true })
    await t.controller.onToggleAuto()
    expect(t.calls).toEqual(['auto:true'])
    expect(t.badges).toEqual(['auto-off'])
  })
})

describe('a failing setBadge', () => {
  test('onTrigger still schedules the ack check and resolves', async () => {
    const t = setup({ badgeThrows: true })
    await t.controller.onTrigger()
    expect(t.scheduled.map((s) => s.ms)).toEqual([10_000])
    t.setStatus(status({ pendingAck: true }))
    await t.scheduled[0].fn() // the check itself must not reject either
    expect(t.badges).toEqual(['sent', 'no-ack'])
  })

  test('onToggleAuto still applies the change and resolves', async () => {
    const t = setup({ badgeThrows: true })
    await t.controller.onToggleAuto()
    expect(t.calls).toEqual(['auto:true'])
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

  test('a failing storage write still posts the caption, does not reject, and does not wedge the queue', async () => {
    const err = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const t = setup({ setTabsFails: 1 })
      await t.controller.onCaption(7, update('a'))
      expect(t.calls).toEqual(['caption:a'])
      expect(err).toHaveBeenCalled()
      await t.controller.onCaption(8, update('b'))
      expect(t.calls).toEqual(['caption:a', 'caption:b'])
      expect(t.tabs()).toEqual([8])
    } finally {
      err.mockRestore()
    }
  })

  test('concurrent captions from two new tabs both end up persisted', async () => {
    const t = setup({ getTabsDelayMs: 10 })
    await Promise.all([t.controller.onCaption(7, update('a')), t.controller.onCaption(8, update('b'))])
    expect(t.tabs().sort()).toEqual([7, 8])
  })

  test('removal resets only for a tab that sent captions, and only once', async () => {
    const t = setup()
    await t.controller.onCaption(7, update())
    await t.controller.onTabRemoved(99)
    expect(t.calls.some((c) => c.startsWith('reset'))).toBe(false)
    await t.controller.onTabRemoved(7)
    await t.controller.onTabRemoved(7)
    expect(t.calls.filter((c) => c.startsWith('reset'))).toEqual(['reset:7']) // only the closed tab's buffer
  })

  test('captions carry their tab id; focus is forwarded to the bridge', async () => {
    const t = setup()
    await t.controller.onCaption(7, update('a'))
    await t.controller.onCaption(8, update('b'))
    await t.controller.onFocus(8)
    expect(t.captionTabs).toEqual([7, 8])
    expect(t.calls).toContain('focus:8')
  })

  test('a new controller over the same storage still resets (service worker restart)', async () => {
    const t = setup()
    await t.controller.onCaption(7, update())
    const reborn = createController(t.deps)
    await reborn.onTabRemoved(7)
    expect(t.calls).toContain('reset:7')
  })
})

describe('onCapture', () => {
  const payload: CapturePayload = { url: 'u', title: 't', text: 'x', png: 'AQID' }

  test("'sent' sets the badge, then 'no-ack' once the check finds pendingAck", async () => {
    const t = setup()
    await t.controller.onCapture(payload)
    expect(t.badges).toEqual(['sent'])
    expect(t.scheduled.map((s) => s.ms)).toEqual([10_000])
    t.setStatus(status({ pendingAck: true }))
    await t.scheduled[0].fn()
    expect(t.badges).toEqual(['sent', 'no-ack'])
  })

  test("'down' sets the badge and schedules nothing", async () => {
    const t = setup({ capture: 'down' })
    await t.controller.onCapture(payload)
    expect(t.badges).toEqual(['down'])
    expect(t.scheduled).toEqual([])
  })
})
