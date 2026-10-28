import { describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { observe, type Extract } from './observe'
import type { CaptionUpdate } from '../../../shared/types'

// Platform-neutral stand-in extractor: every <p id=..> under the root is a block.
const baseExtract: Extract = (root, _selfNames, ts) =>
  Array.from(root.querySelectorAll('p')).map((p) => ({ blockId: p.id, speaker: 'interviewer', speakerName: 'A', text: p.textContent ?? '', ts }))

const RECHECK_MS = 20 // real timers: happy-dom's MutationObserver is timer-driven too, so fake timers would have to cover both
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
// MutationObserver callbacks are delivered asynchronously.
const flush = () => sleep(0)

const setup = (html = '') => {
  const doc = new Window().document as unknown as Document
  doc.body.innerHTML = `<div id="root">${html}</div><div id="outside"></div>`
  const state = { root: doc.getElementById('root') as Element | null, extracts: 0, finds: 0 }
  const extract: Extract = (root, selfNames, ts) => {
    state.extracts++
    return baseExtract(root, selfNames, ts)
  }
  const seen: CaptionUpdate[] = []
  const stop = observe(doc, () => (state.finds++, state.root), extract, [], (u) => seen.push(u), { recheckMs: RECHECK_MS })
  return { doc, state, seen, stop }
}
const html = '<p id="a">hello</p><p id="b">world</p>'
const ids = (seen: CaptionUpdate[]) => seen.map((u) => `${u.blockId}:${u.text}`)

describe('observe', () => {
  test('initial scan emits captions already in the root, with no mutation', () => {
    const { seen, stop } = setup(html)
    expect(ids(seen)).toEqual(['a:hello', 'b:world'])
    stop()
  })

  test('a mutation outside the found root causes no extract call and no emission', async () => {
    const { doc, state, seen, stop } = setup(html)
    const before = state.extracts
    doc.getElementById('outside')!.innerHTML = '<p id="x">elsewhere</p>'
    await flush()
    expect(state.extracts).toBe(before)
    expect(seen).toHaveLength(2)
    stop()
  })

  test('does not re-emit an unchanged block', async () => {
    const { doc, state, seen, stop } = setup()
    state.root!.innerHTML = html
    await flush()
    expect(ids(seen)).toEqual(['a:hello', 'b:world'])
    state.root!.innerHTML = html // same snapshot again: new nodes, same (blockId, text)
    await flush()
    expect(seen).toHaveLength(2)
    stop()
  })

  test("re-emits when a block's text changes", async () => {
    const { doc, state, seen, stop } = setup()
    state.root!.innerHTML = html
    await flush()
    doc.getElementById('a')!.firstChild!.textContent = 'hello there' // in-place interim revision
    await flush()
    expect(ids(seen)).toEqual(['a:hello', 'b:world', 'a:hello there'])
    stop()
  })

  test('replaced root: new and changed blocks are emitted, unchanged ones are not', async () => {
    const { doc, state, seen, stop } = setup(html)
    const next = doc.createElement('div')
    next.innerHTML = '<p id="a">hello</p><p id="b">world!</p><p id="c">new</p>'
    doc.body.replaceChild(next, state.root!)
    state.root = next
    await sleep(RECHECK_MS * 3)
    expect(ids(seen)).toEqual(['a:hello', 'b:world', 'b:world!', 'c:new'])
    // the new root is observed from now on
    next.appendChild(Object.assign(doc.createElement('p'), { id: 'd', textContent: 'live' }))
    await flush()
    expect(ids(seen).at(-1)).toBe('d:live')
    stop()
  })

  test('root that is null at first is picked up on a later re-check', async () => {
    const doc = new Window().document as unknown as Document
    doc.body.innerHTML = `<div id="root">${html}</div>`
    let root: Element | null = null
    const seen: CaptionUpdate[] = []
    const stop = observe(doc, () => root, baseExtract, [], (u) => seen.push(u), { recheckMs: RECHECK_MS })
    expect(seen).toHaveLength(0)
    root = doc.getElementById('root')
    await sleep(RECHECK_MS * 3)
    expect(ids(seen)).toEqual(['a:hello', 'b:world'])
    stop()
  })

  test('stop: no emission afterwards and the interval no longer calls findRoot', async () => {
    const { state, seen, stop } = setup(html)
    state.root!.innerHTML = '<p id="c">pending</p>' // mutation queued but not yet delivered when stop() runs
    stop()
    const finds = state.finds
    state.root!.innerHTML = '<p id="c">late</p>'
    await sleep(RECHECK_MS * 3)
    expect(ids(seen)).toEqual(['a:hello', 'b:world'])
    expect(state.finds).toBe(finds)
  })
})
