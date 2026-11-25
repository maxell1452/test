import { createBridgeClient } from './bridgeClient'
import { createController, type Badge } from './controller'
import { buildPayload, type FrameText } from './capture'
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

const showBadge = async (state: Badge) => {
  const b = state === '' ? BADGES['auto-off'] : BADGES[state]
  await chrome.action.setBadgeText({ text: b.text })
  await chrome.action.setBadgeBackgroundColor({ color: b.color })
}

const controller = createController({
  client: createBridgeClient(fetch),
  setBadge: showBadge,
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
  controller.onCaption(sender.tab.id, msg.update).catch(console.error)
  return false // no reply: returning true would leave the channel open and error when the worker sleeps
})

// Screenshot is required; page text is best-effort (injection fails on restricted pages).
async function captureActiveTab(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (tab?.id === undefined) return
  let dataUrl: string
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
  } catch {
    return showBadge('down')
  }
  let frames: FrameText[] = []
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => ({ url: location.href, text: document.body?.innerText ?? '' }),
    })
    frames = results.flatMap((r) => (r.result ? [r.result] : []))
  } catch {}
  await controller.onCapture(buildPayload(tab, dataUrl, frames))
}

// Tell the bridge which tab is in front. Asked fresh each time (not read from the event) so a closed window or a
// focus change to another app still resolves to the last Chrome tab the user looked at.
async function syncFocus(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (tab?.id !== undefined) await controller.onFocus(tab.id)
}
chrome.tabs.onActivated.addListener(() => void syncFocus().catch(console.error))
chrome.windows.onFocusChanged.addListener(() => void syncFocus().catch(console.error))
void syncFocus().catch(console.error) // worker (re)start: no activation event will announce the current tab

// Reloading or updating the extension orphans the content scripts in tabs that are already open: their
// sendMessage throws "Extension context invalidated" and captions silently stop, while screenshots (sent from
// here) keep working. Inject a fresh copy into the open meeting tabs instead of asking for a page reload.
chrome.runtime.onInstalled.addListener(async () => {
  const matches = chrome.runtime.getManifest().content_scripts?.flatMap((c) => c.matches ?? []) ?? []
  for (const tab of await chrome.tabs.query({ url: matches })) {
    if (tab.id !== undefined)
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['dist/content.js'] }).catch(console.error)
  }
})

chrome.commands.onCommand.addListener((command) => {
  if (command === 'trigger') syncFocus().then(() => controller.onTrigger()).catch(console.error)
  else if (command === 'capture') captureActiveTab().catch(console.error)
  else if (command === 'toggle-auto') controller.onToggleAuto().catch(console.error)
})

chrome.tabs.onRemoved.addListener((tabId) => controller.onTabRemoved(tabId).catch(console.error))
