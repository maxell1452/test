import type { CaptionUpdate, Snapshot, Speaker, Turn } from '../shared/types'

interface OpenTurn {
  speaker: Speaker
  blocks: Map<string, string> // insertion order = order of first sight
  startedAt: number
  endedAt: number
  lastUpdateAt: number // now() at last update, for the silence check
  returned: boolean // already handed out by tick()
}

export class TurnBuffer {
  private turns: OpenTurn[] = []
  private blockTurn = new Map<string, OpenTurn>()
  private lastIngestAt: number | null = null

  constructor(private opts: { turnGapMs: number; now: () => number }) {}

  ingest(u: CaptionUpdate): void {
    const now = this.opts.now()
    this.lastIngestAt = now
    let turn = this.blockTurn.get(u.blockId)
    if (!turn) {
      const last = this.turns[this.turns.length - 1]
      if (last && last.speaker === u.speaker && now - last.lastUpdateAt < this.opts.turnGapMs) {
        turn = last
      } else {
        turn = { speaker: u.speaker, blocks: new Map(), startedAt: u.ts, endedAt: u.ts, lastUpdateAt: now, returned: false }
        this.turns.push(turn)
      }
      this.blockTurn.set(u.blockId, turn)
    }
    turn.blocks.set(u.blockId, u.text)
    turn.endedAt = u.ts
    turn.lastUpdateAt = now
  }

  // Complete = a later turn exists (speaker change or gap split) or the newest turn has been silent for turnGapMs.
  private isComplete(i: number): boolean {
    return i < this.turns.length - 1 || this.opts.now() - this.turns[i].lastUpdateAt >= this.opts.turnGapMs
  }

  private toTurn(t: OpenTurn): Turn {
    return { speaker: t.speaker, text: [...t.blocks.values()].join(' '), startedAt: t.startedAt, endedAt: t.endedAt }
  }

  snapshot(): { snapshot: Snapshot } | { reason: 'no-question' | 'in-progress' } {
    const n = this.turns.length
    if (n && this.turns[n - 1].speaker === 'interviewer' && !this.isComplete(n - 1)) return { reason: 'in-progress' }
    for (let i = n - 1; i >= 0; i--) {
      if (this.turns[i].speaker !== 'interviewer' || !this.isComplete(i)) continue
      const prior = this.turns[i - 1]
      return {
        snapshot: {
          question: this.toTurn(this.turns[i]),
          priorAnswer: prior?.speaker === 'user' ? this.toTurn(prior) : null,
        },
      }
    }
    return { reason: 'no-question' }
  }

  tick(): Turn[] {
    const out: Turn[] = []
    this.turns.forEach((t, i) => {
      if (t.speaker === 'interviewer' && !t.returned && this.isComplete(i)) {
        t.returned = true
        out.push(this.toTurn(t))
      }
    })
    return out
  }

  lastCaptionAgeMs(): number | null {
    return this.lastIngestAt === null ? null : this.opts.now() - this.lastIngestAt
  }

  clear(): void {
    this.turns = []
    this.blockTurn.clear()
    this.lastIngestAt = null
  }
}
