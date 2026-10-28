import { describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { extractTeams } from './teams'
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

  test('skips blocks with no avatar id or no text', () => {
    doc.body.innerHTML = `<div data-tid="closed-caption-v2-virtual-list-content">
      <div role="log"><span data-tid="author">A</span><span data-tid="closed-caption-text">no avatar</span></div>
      <div role="log"><span role="img" id="avatar-x1"></span><span data-tid="author">A</span><span data-tid="closed-caption-text">  </span></div>
      <div role="log"><span role="img" id="avatar-x2"></span><span data-tid="author">A</span><span data-tid="closed-caption-text"> kept </span></div>
    </div>`
    expect(extractTeams(doc.body, [], 7)).toEqual([{ blockId: 'avatar-x2', speaker: 'interviewer', speakerName: 'A', text: 'kept', ts: 7 }])
  })
})
