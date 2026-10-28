import type { CaptionUpdate } from '../../../shared/types'
import type { Extract } from './observe'

// Selectors read off the recorded fixture (extension/fixtures/teams.json); Fluent's hashed atomic classes are
// unstable, so only data-tid/role/id and the component class .fui-ChatMessageCompact (present on every block) are used.
const BLOCK = '.fui-ChatMessageCompact'
const AUTHOR = '[data-tid="author"]'
const TEXT = '[data-tid="closed-caption-text"]'
// The avatar's React useId is the per-block identity that survives virtualisation (list indices shift as old
// blocks scroll out); the block itself carries no id.
const AVATAR = 'span[role="img"][id^="avatar-"]'
const STAMP = 'data-caption-id'

// Probed in priority order, one query each. A single combined selector matches in document order,
// and the call bar's Captions on/off control also has a closed-caption data-tid and can come earlier in the page.
const ROOTS = [
  '[data-tid="closed-caption-renderer-wrapper"]',
  '[data-tid="closed-caption-v2-window-wrapper"]',
  '[data-tid="closed-captions-renderer"]',
]
const ANY_CAPTION_TID = '[data-tid*="closed-caption"]'

export function findTeamsCaptionRoot(doc: Document): Element | null {
  for (const selector of ROOTS) {
    const el = doc.querySelector(selector)
    if (el) return el
  }
  // None of the known wrappers: climb from the first caption text via closest() and settle on the topmost
  // element whose data-tid mentions captions (stays null if the page shows no caption text at all).
  let root: Element | null = null
  let hop = doc.querySelector(TEXT)?.parentElement?.closest(ANY_CAPTION_TID)
  while (hop) {
    root = hop
    hop = hop.parentElement?.closest(ANY_CAPTION_TID)
  }
  return root
}

export const extractTeams: Extract = (root, selfNames, ts) => {
  const updates: CaptionUpdate[] = []
  for (const block of Array.from(root.querySelectorAll(BLOCK))) {
    const text = block.querySelector(TEXT)?.textContent?.trim()
    const speakerName = block.querySelector(AUTHOR)?.textContent?.trim()
    if (!text || !speakerName) continue // incomplete block; also keeps it from being stamped
    // No avatar: stamp the node once so later scans of it keep the same id.
    const blockId = block.querySelector(AVATAR)?.id || block.getAttribute(STAMP) || stamp(block)
    updates.push({ blockId, speaker: selfNames.includes(speakerName) ? 'user' : 'interviewer', speakerName, text, ts })
  }
  return updates
}

function stamp(block: Element): string {
  const id = `caption-${crypto.randomUUID()}`
  block.setAttribute(STAMP, id)
  return id
}
