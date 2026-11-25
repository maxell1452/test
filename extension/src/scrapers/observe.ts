import type { CaptionUpdate } from '../../../shared/types'

/** Platform-specific: read every caption block currently under `root`, in DOM order. */
export type Extract = (root: ParentNode, selfNames: string[], ts: number) => CaptionUpdate[]

// Watches only the caption container, not the whole page. The container can be replaced, not yet rendered or
// toggled off and on, so it is re-resolved on an interval. Re-extracts on every mutation inside it and forwards
// only blocks that are new or whose text changed.
export function observe(
  doc: Document,
  findRoot: (doc: Document) => Element | null,
  extract: Extract,
  selfNames: string[],
  onUpdate: (u: CaptionUpdate) => void,
  opts: { recheckMs?: number } = {},
): () => void {
  const emitted = new Map<string, string>() // blockId -> last emitted text; survives a re-attach so a new container does not replay
  let observer: MutationObserver | null = null
  let current: Element | null = null
  let stopped = false

  const scan = (root: Element) => {
    if (stopped) return // a late callback after stop()
    for (const u of extract(root, selfNames, Date.now())) {
      if (emitted.get(u.blockId) === u.text) continue
      emitted.set(u.blockId, u.text)
      onUpdate(u)
    }
  }

  const attach = () => {
    const root = findRoot(doc)
    if (root === current) return
    observer?.disconnect()
    observer = null
    current = root
    if (!root) return
    observer = new (doc.defaultView!.MutationObserver)(() => scan(root))
    observer.observe(root, { childList: true, subtree: true, characterData: true })
    scan(root) // captions already on screen produce no mutation
  }

  attach()
  const timer = setInterval(attach, opts.recheckMs ?? 10_000)
  return () => {
    stopped = true
    clearInterval(timer)
    observer?.disconnect()
  }
}
