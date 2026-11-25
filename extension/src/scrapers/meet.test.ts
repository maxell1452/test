import { describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { extractMeet, findMeetCaptionRoot } from './meet'
import type { CaptionUpdate } from '../../../shared/types'

interface Fixture {
  selfName: string
  snapshots: { t: number; html: string }[]
}
// Real recorded Meet caption regions: snapshots of the region's outerHTML. The English one ends with captions switched off.
const FIXTURES = [
  { file: 'meet.json', self: 'You', label: 'Captions', question: /tell me about/i, answer: /migration/i },
  { file: 'vi-meet.json', self: 'Bạn', label: 'Phụ đề', question: /second person/i, answer: /first person/i },
]

const doc = new Window().document as unknown as Document

for (const { file, self, label, question, answer } of FIXTURES) {
  const fixture: Fixture = await Bun.file(new URL(`../../fixtures/${file}`, import.meta.url)).json()
  const replay = (): CaptionUpdate[][] =>
    fixture.snapshots.map(({ t, html }) => {
      doc.body.innerHTML = html
      return extractMeet(findMeetCaptionRoot(doc)!, [fixture.selfName], t)
    })
  const all = replay().flat()

  describe(`extractMeet on ${file}`, () => {
    test('the recording is for the language under test', () => {
      expect(fixture.selfName).toBe(self)
      doc.body.innerHTML = fixture.snapshots[0].html
      expect(findMeetCaptionRoot(doc)?.getAttribute('aria-label')).toBe(label)
    })

    test('finds the other participant and the user, labelled as Meet shows them', () => {
      expect(all.some((u) => u.speaker === 'interviewer' && u.speakerName === 'Vương Vũ' && question.test(u.text))).toBe(true)
      expect(all.some((u) => u.speaker === 'user' && u.speakerName === self && answer.test(u.text))).toBe(true)
    })

    test('blockId is stable per block: one speaker each, one id per block on screen', () => {
      const names = new Map<string, Set<string>>()
      for (const u of all) names.set(u.blockId, (names.get(u.blockId) ?? new Set()).add(u.speakerName))
      const maxBlocks = Math.max(...replay().map((s) => s.length))
      expect(maxBlocks).toBeGreaterThan(4)
      expect(names.size).toBe(maxBlocks)
      for (const set of names.values()) expect(set.size).toBe(1)
    })

    test('one update per block, no repeated blockId within a snapshot, no empty text', () => {
      for (const updates of replay()) {
        expect(new Set(updates.map((u) => u.blockId)).size).toBe(updates.length)
        for (const u of updates) expect(u.text).not.toBe('')
      }
    })

    test('a block keeps its blockId while its text changes', () => {
      const byId = new Map<string, Set<string>>()
      for (const u of all) byId.set(u.blockId, (byId.get(u.blockId) ?? new Set()).add(u.text))
      expect(Math.max(...[...byId.values()].map((t) => t.size))).toBeGreaterThan(1)
    })

    test('speaker is user exactly for selfName', () => {
      for (const u of all) expect(u.speaker).toBe(u.speakerName === self ? 'user' : 'interviewer')
      expect(all.some((u) => u.speaker === 'user')).toBe(true)
      expect(all.some((u) => u.speaker === 'interviewer')).toBe(true)
    })
  })
}

describe('extractMeet', () => {
  test('captions switched off: the region is still there but yields nothing', async () => {
    const f: Fixture = await Bun.file(new URL('../../fixtures/meet.json', import.meta.url)).json()
    doc.body.innerHTML = f.snapshots.at(-1)!.html
    expect(extractMeet(findMeetCaptionRoot(doc)!, ['You'], 1)).toEqual([])
  })

  const block = (name: string, text: string, img = '<img data-iml="1">') =>
    `<div><div>${img}<div><span>${name}</span></div></div><div>${text}</div></div>`

  test('block without data-iml is still extracted, with a stable stamped id', () => {
    doc.body.innerHTML = block('A', 'no iml', '<img>')
    const [first] = extractMeet(doc.body, [], 1)
    const [second] = extractMeet(doc.body, [], 2)
    expect(first.text).toBe('no iml')
    expect(first.blockId).toBeTruthy()
    expect(second.blockId).toBe(first.blockId)
  })

  test('skips a block with no text yet, before stamping it', () => {
    doc.body.innerHTML = block('A', '  ', '<img>') + block('B', ' kept ')
    expect(extractMeet(doc.body, [], 7)).toEqual([{ blockId: 'meet-1', speaker: 'interviewer', speakerName: 'B', text: 'kept', ts: 7 }])
    expect(doc.body.querySelector('[data-caption-id]')).toBeNull()
  })

  test('ignores non-block children such as the settings bar', () => {
    doc.body.innerHTML = `<div></div><div><button>Settings</button></div>` + block('A', 'real')
    expect(extractMeet(doc.body, [], 1).map((u) => u.text)).toEqual(['real'])
  })
})

describe('findMeetCaptionRoot', () => {
  test('finds the region under each known label', () => {
    for (const label of ['Captions', 'Phụ đề']) {
      doc.body.innerHTML = `<div role="region" aria-label="${label}" id="r"></div>`
      expect(findMeetCaptionRoot(doc)?.id).toBe('r')
    }
  })

  test('ignores other regions', () => {
    doc.body.innerHTML = `<div role="region" aria-label="Chat"></div>`
    expect(findMeetCaptionRoot(doc)).toBeNull()
  })

  test('is null when the page has no captions region', () => {
    doc.body.innerHTML = `<div>lobby</div>`
    expect(findMeetCaptionRoot(doc)).toBeNull()
  })
})
