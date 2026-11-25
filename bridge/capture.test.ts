import { expect, test } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeCapture } from './capture'

test('writeCapture writes shot.png and page.txt under <base>/<id> and returns that dir', async () => {
  const base = await mkdtemp(join(tmpdir(), 'cap-test-'))
  const dir = await writeCapture(base, 'ev1', new Uint8Array([137, 80, 78, 71]), 'hello page')
  expect(dir).toBe(join(base, 'ev1'))
  expect([...new Uint8Array(await readFile(join(dir, 'shot.png')))]).toEqual([137, 80, 78, 71])
  expect(await readFile(join(dir, 'page.txt'), 'utf8')).toBe('hello page')
})
