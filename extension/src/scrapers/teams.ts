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

// Tried one at a time: a comma-joined list would return whichever match comes first in DOM order, and in the
// 2026 redesign that is the toolbar's Captions control, not the caption panel.
const ROOTS = [
  '[data-tid="closed-caption-renderer-wrapper"]',
  '[data-tid="closed-caption-v2-window-wrapper"]',
  '[data-tid="closed-captions-renderer"]',
]
const LOOSE_ROOT = '[data-tid*="closed-caption"]'

export function findTeamsCaptionRoot(doc: Document): Element | null {
  for (const selector of ROOTS) {
    const el = doc.querySelector(selector)
    if (el) return el
  }
  // Unknown layout: the outermost loose match that wraps real caption text.
  let root: Element | null = null
  for (let el = doc.querySelector(TEXT)?.parentElement; el; el = el.parentElement) {
    if (el.matches(LOOSE_ROOT)) root = el
  }
  return root
}

export const extractTeams: Extract = (root, selfNames, ts) => {
  const updates: CaptionUpdate[] = []
  for (const block of Array.from(root.querySelectorAll(BLOCK))) {
    const text = block.querySelector(TEXT)?.textContent?.trim()
    if (!text) continue
    // No avatar: stamp the node once so later scans of it keep the same id.
    const blockId = block.querySelector(AVATAR)?.id || (block.getAttribute(STAMP) ?? stamp(block))
    const speakerName = block.querySelector(AUTHOR)?.textContent?.trim() ?? ''
    updates.push({ blockId, speaker: selfNames.includes(speakerName) ? 'user' : 'interviewer', speakerName, text, ts })
  }
  return updates
}

function stamp(block: Element): string {
  const id = `caption-${crypto.randomUUID()}`
  block.setAttribute(STAMP, id)
  return id
}
