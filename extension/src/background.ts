import { createBridgeClient } from './bridgeClient'
import { createController, type Badge } from './controller'
import type { CaptionUpdate } from '../../shared/types'

const GREEN = '#2e7d32'
const AMBER = '#f9a825'
const RED = '#c62828'
const BADGES: Record<Exclude<Badge, ''>, { text: string; color: string }> = {
  sent: { text: 'SENT', color: GREEN },
  'auto-on': { text: 'AUTO', color: GREEN },
  waiting: { text: 'WAIT', color: AMBER },
  'no-question': { text: 'NOQ', color: AMBER },
  'no-captions': { text: 'NOCC', color: AMBER },
  duplicate: { text: 'DUP', color: AMBER },
  down: { text: 'DOWN', color: RED },
  'no-ack': { text: 'NOAK', color: RED },
  'auto-off': { text: '', color: GREEN }, // empty text clears the badge
}

const TABS = 'tabs'

const controller = createController({
  client: createBridgeClient(fetch),
  setBadge: async (state) => {
    const b = state === '' ? BADGES['auto-off'] : BADGES[state]
    await chrome.action.setBadgeText({ text: b.text })
    await chrome.action.setBadgeBackgroundColor({ color: b.color })
  },
  // session storage outlives worker restarts but not the browser session, which is the right lifetime for "tabs that sent captions".
  storage: {
    getTabs: async () => ((await chrome.storage.session.get(TABS))[TABS] as number[] | undefined) ?? [],
    setTabs: (tabs) => chrome.storage.session.set({ [TABS]: tabs }),
  },
  schedule: (fn, ms) => void setTimeout(fn, ms),
})

// Listeners are registered synchronously at top level, or events that wake a stopped worker are missed.
chrome.runtime.onMessage.addListener((msg: { type?: string; update?: CaptionUpdate }, sender) => {
  if (msg?.type !== 'caption' || !msg.update || sender.tab?.id === undefined) return false
  void controller.onCaption(sender.tab.id, msg.update)
  return false // no reply: returning true would leave the channel open and error when the worker sleeps
})

chrome.commands.onCommand.addListener((command) => {
  if (command === 'trigger') void controller.onTrigger()
  else if (command === 'toggle-auto') void controller.onToggleAuto()
})

chrome.tabs.onRemoved.addListener((tabId) => void controller.onTabRemoved(tabId))
