import { describe, expect, test } from 'bun:test'
import { buildPayload } from './capture'

const PNG = 'data:image/png;base64,AQID'
const tab = { url: 'https://pad.example/1', title: 'Two Sum' }

describe('buildPayload', () => {
  test('strips the data-url prefix and keeps tab url and title', () => {
    expect(buildPayload(tab, PNG, [])).toEqual({ url: tab.url, title: tab.title, text: '', png: 'AQID' })
  })

  test('throws when the screenshot is not a png data url', () => {
    expect(() => buildPayload(tab, 'data:image/jpeg;base64,AQID', [])).toThrow()
  })

  test('a restricted page (no frames) still yields a payload with empty text', () => {
    expect(buildPayload({}, PNG, []).text).toBe('')
    expect(buildPayload({}, PNG, [])).toMatchObject({ url: '', title: '' })
  })

  test('drops empty frames and joins the rest with url headers', () => {
    const p = buildPayload(tab, PNG, [
      { url: 'https://a', text: 'one' },
      { url: 'https://b', text: '' },
      { url: 'https://c', text: 'two' },
    ])
    expect(p.text).toBe('## frame: https://a\none\n\n## frame: https://c\ntwo')
  })

  test('caps each frame at 50,000 chars', () => {
    const p = buildPayload(tab, PNG, [{ url: 'u', text: 'x'.repeat(60_000) }])
    expect(p.text).toBe(`## frame: u\n${'x'.repeat(50_000)}`)
  })
})
