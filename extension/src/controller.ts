import type { BridgeState, createBridgeClient } from './bridgeClient'
import type { CaptionUpdate, CapturePayload } from '../../shared/types'

export type Badge = BridgeState | 'auto-on' | 'auto-off' | ''

// All chrome access is injected so this is testable without a browser. The service worker is killed when idle:
// nothing here is remembered in memory: the tab set lives in storage and autoFire is read from the bridge each time.
export function createController(deps: {
  client: ReturnType<typeof createBridgeClient>
  setBadge: (state: Badge) => void | Promise<void>
  storage: { getTabs(): Promise<number[]>; setTabs(tabs: number[]): Promise<void> }
  schedule: (fn: () => void, ms: number) => void
  ackTimeoutMs?: number
}) {
  const { client, setBadge, storage, schedule } = deps
  const ackTimeoutMs = deps.ackTimeoutMs ?? 10_000
  let tabsQueue: Promise<unknown> = Promise.resolve()

  // Read-modify-write on the tab set must not interleave, or two new tabs can overwrite each other.
  const withTabs = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tabsQueue.then(fn)
    tabsQueue = run.catch(() => {})
    return run
  }

  // The badge is feedback only: a failing chrome.action must never block the work around it.
  const badge = async (state: Badge): Promise<void> => {
    try {
      await setBadge(state)
    } catch (err) {
      console.error('setBadge failed', err)
    }
  }

  // Badge the result; after a send, check later that Claude acked it.
  const afterSend = async (state: BridgeState): Promise<void> => {
    await badge(state)
    if (state !== 'sent') return
    // A plain timer: it relies on the worker staying alive for ackTimeoutMs (inside Chrome's 30 s idle window)
    // and is lost if the worker is terminated first.
    schedule(async () => {
      if ((await client.status())?.pendingAck === true) await badge('no-ack')
    }, ackTimeoutMs)
  }

  return {
    async onCaption(tabId: number, update: CaptionUpdate): Promise<void> {
      await client.postCaption(update, tabId) // first: bookkeeping trouble must not cost a caption
      try {
        await withTabs(async () => {
          const tabs = await storage.getTabs()
          if (!tabs.includes(tabId)) await storage.setTabs([...tabs, tabId])
        })
      } catch (err) {
        console.error('remembering caption tab failed', err)
      }
    },

    // The tab the user is looking at wins when the bridge picks which meeting's question to send.
    onFocus: (tabId: number): Promise<void> => client.focus(tabId),

    onTrigger: async (): Promise<void> => afterSend(await client.trigger()),

    onCapture: async (p: CapturePayload): Promise<void> => afterSend(await client.capture(p)),

    // Flip from what the bridge says now and show what it says afterwards: client.setAuto is fire-and-forget,
    // and the bridge can have restarted since the last toggle.
    async onToggleAuto(): Promise<void> {
      const before = await client.status()
      if (!before) return badge('down')
      await client.setAuto(!before.autoFire)
      const after = await client.status()
      return badge(after ? (after.autoFire ? 'auto-on' : 'auto-off') : 'down')
    },

    // Only a tab that sent captions resets, and only that tab's buffer: closing an unrelated tab, or the other
    // meeting, must not wipe a live interview.
    async onTabRemoved(tabId: number): Promise<void> {
      const known = await withTabs(async () => {
        const tabs = await storage.getTabs()
        if (!tabs.includes(tabId)) return false
        await storage.setTabs(tabs.filter((t) => t !== tabId))
        return true
      })
      if (known) await client.reset(tabId)
    },
  }
}
