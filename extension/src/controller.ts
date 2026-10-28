import type { BridgeState, createBridgeClient } from './bridgeClient'
import type { CaptionUpdate } from '../../shared/types'

export type Badge = BridgeState | 'auto-on' | 'auto-off' | ''

// All chrome access is injected so this is testable without a browser. The service worker is killed when idle:
// nothing here may be remembered in memory except what can be re-derived (autoFire from the bridge).
export function createController(deps: {
  client: ReturnType<typeof createBridgeClient>
  setBadge: (state: Badge) => void | Promise<void>
  storage: { getTabs(): Promise<number[]>; setTabs(tabs: number[]): Promise<void> }
  schedule: (fn: () => void, ms: number) => void
  ackTimeoutMs?: number
}) {
  const { client, setBadge, storage, schedule } = deps
  const ackTimeoutMs = deps.ackTimeoutMs ?? 10_000
  let auto: boolean | null = null // null until first toggle: seeded from the bridge, which outlives this worker
  let tabsQueue: Promise<unknown> = Promise.resolve()

  // Read-modify-write on the tab set must not interleave, or two new tabs can overwrite each other.
  const withTabs = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tabsQueue.then(fn)
    tabsQueue = run.catch(() => {})
    return run
  }

  return {
    async onCaption(tabId: number, update: CaptionUpdate): Promise<void> {
      await withTabs(async () => {
        const tabs = await storage.getTabs()
        if (!tabs.includes(tabId)) await storage.setTabs([...tabs, tabId])
      })
      await client.postCaption(update)
    },

    async onTrigger(): Promise<void> {
      const state = await client.trigger()
      await setBadge(state)
      if (state !== 'sent') return
      schedule(async () => {
        if ((await client.status())?.pendingAck === true) await setBadge('no-ack')
      }, ackTimeoutMs)
    },

    async onToggleAuto(): Promise<void> {
      if (auto === null) {
        const s = await client.status()
        if (!s) return setBadge('down') // can't know the real state, so don't pretend to flip it
        auto = s.autoFire
      }
      auto = !auto
      await client.setAuto(auto)
      await setBadge(auto ? 'auto-on' : 'auto-off')
    },

    // Only a tab that sent captions resets the buffer; closing an unrelated tab must not wipe a live interview.
    async onTabRemoved(tabId: number): Promise<void> {
      const known = await withTabs(async () => {
        const tabs = await storage.getTabs()
        if (!tabs.includes(tabId)) return false
        await storage.setTabs(tabs.filter((t) => t !== tabId))
        return true
      })
      if (known) await client.reset()
    },
  }
}
