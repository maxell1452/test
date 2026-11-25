import { findTeamsCaptionRoot, extractTeams } from './teams'
import { findMeetCaptionRoot, extractMeet } from './meet'
import type { Extract } from './observe'

export type Scraper = { findRoot: (doc: Document) => Element | null; extract: Extract }

// Exact hostnames only: the manifest match patterns are generated from the same lists, see index.test.ts.
export const TEAMS_HOSTS = ['teams.microsoft.com', 'teams.cloud.microsoft', 'teams.live.com'] as const

export const MEET_HOSTS = ['meet.google.com'] as const

const TEAMS: Scraper = { findRoot: findTeamsCaptionRoot, extract: extractTeams }
const MEET: Scraper = { findRoot: findMeetCaptionRoot, extract: extractMeet }

export function scraperFor(hostname: string): Scraper | null {
  if ((TEAMS_HOSTS as readonly string[]).includes(hostname)) return TEAMS
  if ((MEET_HOSTS as readonly string[]).includes(hostname)) return MEET
  return null
}
