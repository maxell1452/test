import { findTeamsCaptionRoot, extractTeams } from './teams'
import type { Extract } from './observe'

export type Scraper = { findRoot: (doc: Document) => Element | null; extract: Extract }

// Exact hostnames only: the manifest match patterns are generated from the same three, see index.test.ts.
export const TEAMS_HOSTS = ['teams.microsoft.com', 'teams.cloud.microsoft', 'teams.live.com'] as const

const TEAMS: Scraper = { findRoot: findTeamsCaptionRoot, extract: extractTeams }

export function scraperFor(hostname: string): Scraper | null {
  return (TEAMS_HOSTS as readonly string[]).includes(hostname) ? TEAMS : null
}
