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

// One TurnBuffer per browser tab, so two captioned meetings never merge into one turn.
// Which tab answers a trigger: the tab the user is looking at, else the one they looked at last, else the latest to caption.
// ponytail: tab ids are never pruned except by clear(tab); a handful per session, fine.
export class TabBuffers {
  private bufs = new Map<number, TurnBuffer>()
  private focused: number[] = [] // most recently focused first
  private lastCaptionTab: number | null = null

  constructor(private opts: { turnGapMs: number; now: () => number }) {}

  ingest(u: CaptionUpdate): void {
    const tab = u.tabId ?? 0
    let buf = this.bufs.get(tab)
    if (!buf) this.bufs.set(tab, (buf = new TurnBuffer(this.opts)))
    buf.ingest(u)
    this.lastCaptionTab = tab
  }

  focus(tab: number): void {
    this.focused = [tab, ...this.focused.filter((t) => t !== tab)]
  }

  // Focus only counts for tabs that have captions: looking at the coding page must not hide the meeting tab behind it.
  private pick(): TurnBuffer | undefined {
    const tab = this.focused.find((t) => this.bufs.has(t)) ?? this.lastCaptionTab ?? [...this.bufs.keys()].pop()
    return tab === undefined ? undefined : this.bufs.get(tab)
  }

  snapshot(): ReturnType<TurnBuffer['snapshot']> {
    return this.pick()?.snapshot() ?? { reason: 'no-question' }
  }

  // Every tab is drained so enabling auto later never answers old turns, but only the winning tab's turns count:
  // auto-fire sends snapshot(), so a turn from another meeting must not trigger a re-send of this one's question.
  tick(): Turn[] {
    const winner = this.pick()
    let out: Turn[] = []
    for (const b of this.bufs.values()) {
      const turns = b.tick()
      if (b === winner) out = turns
    }
    return out
  }

  lastCaptionAgeMs(): number | null {
    const ages = [...this.bufs.values()].map((b) => b.lastCaptionAgeMs()).filter((a): a is number => a !== null)
    return ages.length ? Math.min(...ages) : null
  }

  // No tab = everything (manual reset); a tab = only that meeting, so closing one tab cannot wipe the other.
  clear(tab?: number): void {
    if (tab === undefined) {
      this.bufs.clear()
      this.focused = []
      this.lastCaptionTab = null
      return
    }
    this.bufs.delete(tab)
    this.focused = this.focused.filter((t) => t !== tab)
    if (this.lastCaptionTab === tab) this.lastCaptionTab = null
  }
}
