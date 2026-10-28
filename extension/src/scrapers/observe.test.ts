import { describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { observe, type Extract } from './observe'
import type { CaptionUpdate } from '../../../shared/types'

// Platform-neutral stand-in extractor: every <p id=..> is a block.
const extract: Extract = (root, _selfNames, ts) =>
  Array.from(root.querySelectorAll('p')).map((p) => ({ blockId: p.id, speaker: 'interviewer', speakerName: 'A', text: p.textContent ?? '', ts }))

const setup = () => {
  const doc = new Window().document as unknown as Document
  const seen: CaptionUpdate[] = []
  const stop = observe(doc, extract, [], (u) => seen.push(u))
  // MutationObserver callbacks are delivered asynchronously.
  const flush = () => new Promise((r) => setTimeout(r, 0))
  return { doc, seen, stop, flush }
}
const html = '<p id="a">hello</p><p id="b">world</p>'

describe('observe', () => {
  test('does not re-emit an unchanged block', async () => {
    const { doc, seen, flush } = setup()
    doc.body.innerHTML = html
    await flush()
    expect(seen.map((u) => u.blockId)).toEqual(['a', 'b'])
    doc.body.innerHTML = html // same snapshot again: new nodes, same (blockId, text)
    await flush()
    expect(seen).toHaveLength(2)
  })

  test("re-emits when a block's text changes", async () => {
    const { doc, seen, flush } = setup()
    doc.body.innerHTML = html
    await flush()
    doc.getElementById('a')!.firstChild!.textContent = 'hello there' // in-place interim revision
    await flush()
    expect(seen.map((u) => `${u.blockId}:${u.text}`)).toEqual(['a:hello', 'b:world', 'a:hello there'])
  })

  test('stop function disconnects', async () => {
    const { doc, seen, stop, flush } = setup()
    doc.body.innerHTML = html
    await flush()
    stop()
    doc.body.innerHTML = '<p id="c">late</p>'
    await flush()
    expect(seen.map((u) => u.blockId)).toEqual(['a', 'b'])
  })
})
