import { beforeEach, describe, expect, test } from 'bun:test'
import { TabBuffers, TurnBuffer } from './turns'
import type { CaptionUpdate, Speaker } from '../shared/types'

const GAP = 1500
let t = 0
let buf: TurnBuffer

const upd = (blockId: string, speaker: Speaker, text: string, ts = t): CaptionUpdate => ({
  blockId,
  speaker,
  speakerName: speaker === 'user' ? 'Me' : 'Interviewer',
  text,
  ts,
})
const say = (blockId: string, speaker: Speaker, text: string, ts = t) => buf.ingest(upd(blockId, speaker, text, ts))
const question = (r: ReturnType<TurnBuffer['snapshot']>) => ('snapshot' in r ? r.snapshot.question : null)

beforeEach(() => {
  t = 1000
  buf = new TurnBuffer({ turnGapMs: GAP, now: () => t })
})

describe('TurnBuffer', () => {
  test('rewrites a block in place', () => {
    say('a', 'interviewer', 'Tell me about your')
    t += 100
    say('a', 'interviewer', 'Tell me about yourself')
    t += GAP
    expect(question(buf.snapshot())!.text).toBe('Tell me about yourself')
  })

  test('joins same-speaker blocks into one turn', () => {
    say('a', 'interviewer', 'one')
    t += 500
    say('b', 'interviewer', 'two')
    t += GAP
    const q = question(buf.snapshot())!
    expect(q.text).toBe('one two')
    expect(buf.tick()).toHaveLength(1)
  })

  test('turn startedAt/endedAt come from update ts, not now()', () => {
    say('a', 'interviewer', 'one', 5000)
    t += 500
    say('b', 'interviewer', 'two', 5200)
    t += GAP
    say('a', 'interviewer', 'one!', 5300) // rewrite refreshes endedAt
    t += GAP
    const q = question(buf.snapshot())!
    expect(q.startedAt).toBe(5000)
    expect(q.endedAt).toBe(5300)
  })

  test('speaker change completes the turn immediately', () => {
    say('a', 'interviewer', 'What is a closure?')
    say('b', 'user', 'Well')
    const r = buf.snapshot()
    if (!('snapshot' in r)) throw new Error('expected snapshot')
    expect(r.snapshot.question.text).toBe('What is a closure?')
    expect(r.snapshot.priorAnswer).toBeNull()
  })

  test('silence completes the turn', () => {
    say('a', 'interviewer', 'Why us?')
    t += GAP - 1
    expect(buf.snapshot()).toEqual({ reason: 'in-progress' })
    t += 1
    expect(question(buf.snapshot())!.text).toBe('Why us?')
  })

  test('empty buffer', () => {
    expect(buf.snapshot()).toEqual({ reason: 'no-question' })
  })

  test('only user speech is no-question', () => {
    say('a', 'user', 'hello')
    t += GAP
    expect(buf.snapshot()).toEqual({ reason: 'no-question' })
  })

  test('priorAnswer is the user turn before the question', () => {
    say('a', 'user', 'I did X')
    say('b', 'interviewer', 'Why X?')
    t += GAP
    const r = buf.snapshot()
    if (!('snapshot' in r)) throw new Error('expected snapshot')
    expect(r.snapshot.question.text).toBe('Why X?')
    expect(r.snapshot.priorAnswer!.text).toBe('I did X')
    expect(r.snapshot.priorAnswer!.speaker).toBe('user')
  })

  test('back-to-back questions: latest wins', () => {
    say('a', 'interviewer', 'First question?')
    t += GAP
    say('b', 'interviewer', 'Second question?')
    t += GAP
    const r = buf.snapshot()
    if (!('snapshot' in r)) throw new Error('expected snapshot')
    expect(r.snapshot.question.text).toBe('Second question?')
    expect(r.snapshot.priorAnswer).toBeNull()
  })

  test('open interviewer turn after a completed one is in-progress', () => {
    say('a', 'interviewer', 'First?')
    say('b', 'user', 'answer')
    say('c', 'interviewer', 'Follow')
    expect(buf.snapshot()).toEqual({ reason: 'in-progress' })
  })

  test('open user turn still returns the completed interviewer turn', () => {
    say('a', 'interviewer', 'Question?')
    say('b', 'user', 'um')
    t += 10
    expect(question(buf.snapshot())!.text).toBe('Question?')
  })

  test('rewriting a block in a speaker-completed turn does not reopen it', () => {
    say('a', 'interviewer', 'Tell me about')
    say('b', 'user', 'ok')
    t += GAP
    say('a', 'interviewer', 'Tell me about yourself')
    t += 10
    expect(question(buf.snapshot())!.text).toBe('Tell me about yourself')
  })

  test('tick returns each completed interviewer turn once', () => {
    say('a', 'interviewer', 'Q1?')
    expect(buf.tick()).toEqual([])
    t += GAP
    const first = buf.tick()
    expect(first.map((x) => x.text)).toEqual(['Q1?'])
    expect(buf.tick()).toEqual([])
  })

  test('tick skips user turns', () => {
    say('a', 'user', 'mine')
    say('b', 'interviewer', 'Q?')
    t += GAP
    expect(buf.tick().map((x) => x.speaker)).toEqual(['interviewer'])
  })

  test('tick does not return a turn rewritten after it was returned', () => {
    say('a', 'interviewer', 'Q1')
    say('b', 'user', 'ans')
    expect(buf.tick()).toHaveLength(1)
    say('a', 'interviewer', 'Q1 corrected')
    expect(buf.tick()).toEqual([])
  })

  test('lastCaptionAgeMs is null before any caption', () => {
    expect(buf.lastCaptionAgeMs()).toBeNull()
    say('a', 'user', 'hi')
    t += 250
    expect(buf.lastCaptionAgeMs()).toBe(250)
  })

  test('clear() empties everything', () => {
    say('a', 'user', 'I did X')
    say('b', 'interviewer', 'Why?')
    t += GAP
    buf.clear()
    expect(buf.snapshot()).toEqual({ reason: 'no-question' })
    expect(buf.tick()).toEqual([])
    expect(buf.lastCaptionAgeMs()).toBeNull()
  })
})

describe('TabBuffers', () => {
  let tabs: TabBuffers
  const sayIn = (tabId: number, blockId: string, text: string) =>
    tabs.ingest({ ...upd(blockId, 'interviewer', text), tabId })
  const asked = () => question(tabs.snapshot())?.text

  beforeEach(() => {
    tabs = new TabBuffers({ turnGapMs: GAP, now: () => t })
  })

  test('two meetings never merge into one turn', () => {
    sayIn(1, 'a', 'Question from meeting one')
    sayIn(2, 'b', 'Question from meeting two') // same speaker, inside the gap: one TurnBuffer would merge these
    t += GAP
    tabs.focus(1)
    expect(asked()).toBe('Question from meeting one')
    tabs.focus(2)
    expect(asked()).toBe('Question from meeting two')
  })

  test('the focused tab wins over the one that spoke last', () => {
    sayIn(1, 'a', 'interview question')
    t += 100
    sayIn(2, 'b', 'side meeting chatter')
    t += GAP
    tabs.focus(1)
    expect(asked()).toBe('interview question')
  })

  test('focus on a tab without captions falls back to the last focused meeting', () => {
    sayIn(1, 'a', 'interview question')
    sayIn(2, 'b', 'side meeting chatter')
    t += GAP
    tabs.focus(1)
    tabs.focus(99) // the coding page
    expect(asked()).toBe('interview question')
  })

  test('with no focus, the tab that captioned last wins', () => {
    sayIn(1, 'a', 'first')
    t += 100
    sayIn(2, 'b', 'second')
    t += GAP
    expect(asked()).toBe('second')
  })

  test('tick only returns turns of the winning tab, but drains the others', () => {
    sayIn(1, 'a', 'one')
    sayIn(2, 'b', 'two')
    t += GAP
    tabs.focus(2)
    expect(tabs.tick().map((x) => x.text)).toEqual(['two'])
    tabs.focus(1)
    expect(tabs.tick()).toEqual([]) // tab 1's turn was drained earlier, not queued for later
  })

  test('clear(tab) drops only that tab; clear() drops all', () => {
    sayIn(1, 'a', 'one')
    sayIn(2, 'b', 'two')
    t += GAP
    tabs.focus(1)
    tabs.clear(1)
    expect(asked()).toBe('two')
    tabs.clear()
    expect(asked()).toBeUndefined()
    expect(tabs.lastCaptionAgeMs()).toBeNull()
  })

  test('captions without a tab id share tab 0', () => {
    tabs.ingest(upd('a', 'interviewer', 'hello'))
    t += GAP
    expect(asked()).toBe('hello')
  })
})
