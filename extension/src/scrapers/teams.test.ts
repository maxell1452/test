import { describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { extractTeams, findTeamsCaptionRoot } from './teams'
import type { CaptionUpdate } from '../../../shared/types'

interface Fixture {
  selfName: string
  snapshots: { t: number; html: string }[]
}
// Real recorded Teams-web caption list: 94 snapshots of the container's outerHTML.
const fixture: Fixture = await Bun.file(new URL('../../fixtures/teams.json', import.meta.url)).json()

const doc = new Window().document as unknown as Document
const replay = (): CaptionUpdate[][] =>
  fixture.snapshots.map(({ t, html }) => {
    doc.body.innerHTML = html
    return extractTeams(doc.body, [fixture.selfName], t)
  })
const all = replay().flat()

describe('extractTeams', () => {
  test('finds the interviewer question', () => {
    expect(all.some((u) => u.speaker === 'interviewer' && /tell me about/i.test(u.text))).toBe(true)
  })

  test('finds the user answer', () => {
    expect(all.some((u) => u.speaker === 'user' && u.speakerName === fixture.selfName && u.text.includes('shipped a bug'))).toBe(true)
  })

  test('blockId is stable per block: one speaker each, 20 blocks overall', () => {
    const names = new Map<string, Set<string>>()
    for (const u of all) names.set(u.blockId, (names.get(u.blockId) ?? new Set()).add(u.speakerName))
    expect(names.size).toBe(20)
    for (const set of names.values()) expect(set.size).toBe(1)
  })

  test('one update per block in DOM order, no repeated blockId within a snapshot, no empty text', () => {
    for (const updates of replay()) {
      expect(new Set(updates.map((u) => u.blockId)).size).toBe(updates.length)
      for (const u of updates) expect(u.text).not.toBe('')
    }
  })

  test('speaker is user exactly for selfName', () => {
    for (const u of all) expect(u.speaker).toBe(u.speakerName === fixture.selfName ? 'user' : 'interviewer')
    expect(all.some((u) => u.speaker === 'user')).toBe(true)
    expect(all.some((u) => u.speaker === 'interviewer')).toBe(true)
  })

  test('skips blocks with no text', () => {
    doc.body.innerHTML = `<div class="fui-ChatMessageCompact"><span role="img" id="avatar-x1"></span><span data-tid="author">A</span><span data-tid="closed-caption-text">  </span></div>
      <div class="fui-ChatMessageCompact"><span role="img" id="avatar-x2"></span><span data-tid="author">A</span><span data-tid="closed-caption-text"> kept </span></div>`
    expect(extractTeams(doc.body, [], 7)).toEqual([{ blockId: 'avatar-x2', speaker: 'interviewer', speakerName: 'A', text: 'kept', ts: 7 }])
  })

  test('block without an avatar id is still extracted, with a stable stamped id', () => {
    doc.body.innerHTML = `<div class="fui-ChatMessageCompact"><span data-tid="author">A</span><span data-tid="closed-caption-text">no avatar</span></div>`
    const [first] = extractTeams(doc.body, [], 1)
    const [second] = extractTeams(doc.body, [], 2)
    expect(first.text).toBe('no avatar')
    expect(first.blockId).toBeTruthy()
    expect(second.blockId).toBe(first.blockId)
    expect(doc.body.querySelector('.fui-ChatMessageCompact')!.getAttribute('data-caption-id')).toBe(first.blockId)
  })

  test('only reads blocks inside the given root', () => {
    const block = (id: string, text: string) =>
      `<div class="fui-ChatMessageCompact"><span role="img" id="avatar-${id}"></span><span data-tid="author">A</span><span data-tid="closed-caption-text">${text}</span></div>`
    doc.body.innerHTML = `${block('out', 'decoy')}<div id="root">${block('in', 'real')}</div>`
    expect(extractTeams(doc.getElementById('root')!, [], 1).map((u) => u.text)).toEqual(['real'])
    expect(extractTeams(doc.body, [], 1).map((u) => u.text)).toEqual(['decoy', 'real'])
  })
})

describe('findTeamsCaptionRoot', () => {
  test('tries candidates in order: the wrapper beats an earlier loose data-tid match', () => {
    doc.body.innerHTML = `<button data-tid="closed-captions-button-on">Captions</button>
      <div data-tid="closed-caption-v2-window-wrapper" id="old"></div>
      <div data-tid="closed-caption-renderer-wrapper" id="new"></div>`
    expect(findTeamsCaptionRoot(doc)?.id).toBe('new')
  })

  test('falls back to the outermost caption ancestor of the caption text', () => {
    doc.body.innerHTML = fixture.snapshots[0].html
    expect(findTeamsCaptionRoot(doc)?.getAttribute('data-tid')).toBe('closed-caption-v2-virtual-list-content')
  })

  test('is null when no caption text exists', () => {
    doc.body.innerHTML = `<button data-tid="closed-captions-button-on">Captions</button><div data-tid="closed-caption-x"></div>`
    expect(findTeamsCaptionRoot(doc)).toBeNull()
  })
})
