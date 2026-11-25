import { describe, expect, test } from 'bun:test'
import { MEET_HOSTS, scraperFor, TEAMS_HOSTS } from './index'
import { extractMeet, findMeetCaptionRoot } from './meet'
import { extractTeams, findTeamsCaptionRoot } from './teams'

const manifest: {
  background: { service_worker: string }
  content_scripts: { matches: string[]; js: string[] }[]
  host_permissions: string[]
  permissions: string[]
  action?: unknown
  commands: Record<string, { suggested_key: { default: string } }>
} = await Bun.file(new URL('../../manifest.json', import.meta.url)).json()
const patterns = (hosts: readonly string[]) => hosts.map((h) => `https://${h}/*`)

describe('scraperFor', () => {
  test('returns the Teams scraper for each Teams host', () => {
    for (const host of TEAMS_HOSTS) {
      const s = scraperFor(host)
      expect(s?.findRoot).toBe(findTeamsCaptionRoot)
      expect(s?.extract).toBe(extractTeams)
    }
    expect([...TEAMS_HOSTS]).toEqual(['teams.microsoft.com', 'teams.cloud.microsoft', 'teams.live.com'])
  })

  test('returns the Meet scraper for meet.google.com', () => {
    const s = scraperFor('meet.google.com')
    expect(s?.findRoot).toBe(findMeetCaptionRoot)
    expect(s?.extract).toBe(extractMeet)
    expect([...MEET_HOSTS]).toEqual(['meet.google.com'])
  })

  test('returns null for anything else, lookalikes included', () => {
    for (const host of [
      'google.com',
      'example.com',
      '',
      'teams.microsoft.com.evil.com',
      'evilteams.microsoft.com',
      'sub.teams.microsoft.com',
      'TEAMS.MICROSOFT.COM.',
      'meet.google.com.evil.com',
      'evilmeet.google.com',
      'sub.meet.google.com',
      'MEET.GOOGLE.COM.',
    ]) {
      expect(scraperFor(host)).toBeNull()
    }
  })
})

describe('manifest', () => {
  // Host permissions are <all_urls> only for page capture (any site); the caption content script stays Teams/Meet only.
  test('content script matches are exactly the Teams and Meet hosts; host permissions are <all_urls>', () => {
    const hosts = [...TEAMS_HOSTS, ...MEET_HOSTS]
    expect(manifest.content_scripts).toHaveLength(1)
    expect(manifest.content_scripts[0].matches).toEqual(patterns(hosts))
    expect(manifest.host_permissions).toEqual(['<all_urls>'])
  })

  // Without the "action" key chrome.action is undefined and every badge update throws.
  test('declares the action key', () => {
    expect(manifest.action).toBeDefined()
  })

  test('only the storage and scripting permissions, all three commands declared', () => {
    expect(manifest.permissions).toEqual(['storage', 'scripting'])
    expect(Object.keys(manifest.commands).sort()).toEqual(['capture', 'toggle-auto', 'trigger'])
  })

  // The CLI build is what a user runs; the in-memory build below is what the test checks. They must not drift.
  test('the package.json build script emits exactly the files the manifest names', async () => {
    const pkg: { scripts: { build: string } } = await Bun.file(new URL('../../../package.json', import.meta.url)).json()
    const cmd = pkg.scripts.build
    const outdir = cmd.match(/--outdir (\S+)/)![1]
    const entries = [...cmd.matchAll(/extension\/src\/(\w+)\.ts/g)].map((m) => m[1])
    expect(cmd).toContain('--target browser')
    const emitted = entries.map((e) => `${outdir.replace(/^extension\//, '')}/${e}.js`).sort()
    expect(emitted).toEqual([...manifest.content_scripts[0].js, manifest.background.service_worker].sort())
  })

  // content_scripts.js entries are classic scripts: a top-level import/export is a SyntaxError in the page.
  test('built content.js and background.js are self-contained with the names the manifest uses', async () => {
    const entry = (f: string) => new URL(`../${f}`, import.meta.url).pathname
    const built = await Bun.build({ entrypoints: [entry('content.ts'), entry('background.ts')], target: 'browser' })
    expect(built.success).toBe(true)
    const byName = new Map(built.outputs.map((o) => [o.path.replace(/^\.\//, ''), o]))
    expect([...byName.keys()].sort()).toEqual(['background.js', 'content.js'])
    expect(manifest.content_scripts[0].js).toEqual(['dist/content.js'])
    expect(manifest.background.service_worker).toBe('dist/background.js')
    const content = await byName.get('content.js')!.text()
    expect(content).not.toMatch(/^\s*(import|export)\b/m)
  })
})
