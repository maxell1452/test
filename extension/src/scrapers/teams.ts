import type { CaptionUpdate } from '../../../shared/types'
import type { Extract } from './observe'

// Selectors read off the recorded fixture (extension/fixtures/teams.json); Fluent class names are hashed, so only data-tid/role/id are used.
const BLOCK = '[data-tid="closed-caption-v2-virtual-list-content"] div[role="log"]'
const AUTHOR = '[data-tid="author"]'
const TEXT = '[data-tid="closed-caption-text"]'
// Blocks carry no id of their own; the avatar's React useId is the only per-block identity that survives
// virtualisation (list indices shift as old blocks scroll out).
const AVATAR = 'span[role="img"][id^="avatar-"]'

export const extractTeams: Extract = (root, selfNames, ts) => {
  const updates: CaptionUpdate[] = []
  for (const block of Array.from(root.querySelectorAll(BLOCK))) {
    // No avatar id (never seen in the fixture) -> skip rather than invent an id that could not be stable.
    const blockId = block.querySelector(AVATAR)?.id
    const text = block.querySelector(TEXT)?.textContent?.trim()
    if (!blockId || !text) continue
    const speakerName = block.querySelector(AUTHOR)?.textContent?.trim() ?? ''
    updates.push({ blockId, speaker: selfNames.includes(speakerName) ? 'user' : 'interviewer', speakerName, text, ts })
  }
  return updates
}
