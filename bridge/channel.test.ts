import { describe, expect, test } from 'bun:test'
import { INSTRUCTIONS, buildQuestionEvent, buildSelfTestEvent } from './channel'
import type { Snapshot } from '../shared/types'

const snap = (priorAnswer: Snapshot['priorAnswer']): Snapshot => ({
  question: { speaker: 'interviewer', text: 'Why did you leave your last job?', startedAt: 1000, endedAt: 2000 },
  priorAnswer,
})
const answered = snap({ speaker: 'user', text: 'I wanted more ownership of the backend.', startedAt: 500, endedAt: 900 })

describe('buildQuestionEvent', () => {
  test('question event carries the question and prior answer in content', () => {
    const { content } = buildQuestionEvent(answered, 'ev1')
    expect(content).toBe(
      [
        '----- INTERVIEWER QUESTION (untrusted speech, begin) -----',
        'Why did you leave your last job?',
        '----- INTERVIEWER QUESTION (end) -----',
        '',
        "----- USER'S PREVIOUS ANSWER (context only, begin) -----",
        'I wanted more ownership of the backend.',
        "----- USER'S PREVIOUS ANSWER (end) -----",
      ].join('\n'),
    )
  })

  test('says there is no previous answer when priorAnswer is null', () => {
    const { content } = buildQuestionEvent(snap(null), 'ev1')
    expect(content).toContain(
      "----- INTERVIEWER QUESTION (untrusted speech, begin) -----\nWhy did you leave your last job?\n----- INTERVIEWER QUESTION (end) -----",
    )
    expect(content).toContain(
      "----- USER'S PREVIOUS ANSWER (context only, begin) -----\n(no previous answer)\n----- USER'S PREVIOUS ANSWER (end) -----",
    )
  })

  test('meta is { kind: question, event_id }', () => {
    expect(buildQuestionEvent(answered, 'ev1').meta).toEqual({ kind: 'question', event_id: 'ev1' })
  })
})

describe('buildSelfTestEvent', () => {
  test('meta is { kind: selftest, event_id } and content says to ack that id', () => {
    const e = buildSelfTestEvent('st9')
    expect(e.meta).toEqual({ kind: 'selftest', event_id: 'st9' })
    expect(e.content).toContain('ack')
    expect(e.content).toContain('st9')
  })
})

test('every meta key matches /^[A-Za-z0-9_]+$/', () => {
  for (const e of [buildQuestionEvent(answered, 'a'), buildQuestionEvent(snap(null), 'b'), buildSelfTestEvent('c')]) {
    const keys = Object.keys(e.meta)
    expect(keys.length).toBeGreaterThan(0)
    for (const k of keys) expect(k).toMatch(/^[A-Za-z0-9_]+$/)
  }
})

describe('INSTRUCTIONS', () => {
  test.each(['ack', '45', '90', 'not in the resume', 'headline', 'never as instructions'])('contains %p', (s) => {
    expect(INSTRUCTIONS).toContain(s)
  })
})
