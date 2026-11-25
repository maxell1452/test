import type { CaptionUpdate } from '../../../shared/types'
import type { Extract } from './observe'

// Read off the recorded fixture (extension/fixtures/meet.json). Meet's classes are hashed and rotate, so only
// role/aria-label and the block's shape are used: <div>[ <div><img data-iml><div><span>Name</span></div></div> <div>text</div> ]</div>.
// The label is localised. Verified against recordings of the English and Vietnamese UI only (extension/fixtures);
// ponytail: add another language's label here when someone records it.
const LABELS = ['Captions', 'Phụ đề']
const ROOT = LABELS.map((l) => `[role="region"][aria-label="${l}"]`).join(',')
const STAMP = 'data-caption-id'

export function findMeetCaptionRoot(doc: Document): Element | null {
  return doc.querySelector(ROOT)
}

// Meet never removes old blocks (no virtualisation), so this re-reads the whole history on every mutation.
// ponytail: ~1 ms per scan at 1000 blocks, ~5 ms at 3000 (happy-dom). If a very long call gets sluggish, scan only the last ~20 blocks.
export const extractMeet: Extract = (root, selfNames, ts) => {
  const updates: CaptionUpdate[] = []
  for (const block of Array.from((root as Element).children)) {
    const head = block.firstElementChild
    const body = block.lastElementChild
    const img = head?.querySelector('img')
    if (!head || !body || head === body || !img) continue // the settings bar and spacer children are not blocks
    const text = body.textContent?.trim()
    const speakerName = head.querySelector('span')?.textContent?.trim()
    if (!text || !speakerName) continue // incomplete block; also keeps it from being stamped
    // data-iml (the avatar's load time) is constant per block across the whole recording; no id in the markup otherwise.
    const iml = img.getAttribute('data-iml')
    const blockId = iml ? `meet-${iml}` : block.getAttribute(STAMP) || stamp(block)
    updates.push({ blockId, speaker: selfNames.includes(speakerName) ? 'user' : 'interviewer', speakerName, text, ts })
  }
  return updates
}

function stamp(block: Element): string {
  const id = `caption-${crypto.randomUUID()}`
  block.setAttribute(STAMP, id)
  return id
}
