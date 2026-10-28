import type { CaptionUpdate } from '../../../shared/types'

/** Platform-specific: read every caption block currently under `root`, in DOM order. */
export type Extract = (root: ParentNode, selfNames: string[], ts: number) => CaptionUpdate[]

// Re-extracts on every DOM mutation and forwards only blocks that are new or whose text changed.
export function observe(doc: Document, extract: Extract, selfNames: string[], onUpdate: (u: CaptionUpdate) => void): () => void {
  const emitted = new Map<string, string>() // blockId -> last emitted text
  const observer = new (doc.defaultView!.MutationObserver)(() => {
    for (const u of extract(doc.body, selfNames, Date.now())) {
      if (emitted.get(u.blockId) === u.text) continue
      emitted.set(u.blockId, u.text)
      onUpdate(u)
    }
  })
  observer.observe(doc.body, { childList: true, subtree: true, characterData: true })
  return () => observer.disconnect()
}
