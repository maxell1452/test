# Mock Interview Copilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Chrome extension scrapes live captions from Google Meet and Teams-web, a local bridge buffers them, and a hotkey pushes the interviewer's latest question into the running Claude Code session as a channel event so Claude prints a full model answer in the terminal.

**Architecture:** Two site scrapers share one interface and feed a service worker, which POSTs to a localhost bridge. The bridge is one Bun process: an MCP stdio server (declares `claude/channel`, exposes an `ack` tool) plus a 127.0.0.1 HTTP listener. A pure `TurnBuffer` turns caption updates into completed speaker turns; the HTTP layer decides when to emit an event.

**Tech Stack:** TypeScript, Bun (runtime + `bun test`), `@modelcontextprotocol/sdk`, Chrome MV3, `happy-dom` (dev, DOM tests), `@types/chrome` (dev).

**Spec:** `docs/superpowers/specs/2026-10-27-mock-interview-copilot-design.md`

## Global Constraints

- Chrome only; Meet and Teams **web client** both work in v1 (not Meet-first).
- Bridge binds `127.0.0.1` only; transcripts never leave the machine except via the user's Claude session.
- Output goes to the terminal only; no UI on the call page (a toolbar badge is allowed as the status signal).
- Nothing persists between sessions: in-memory buffer only, bridge exits when Claude Code closes its stdio, buffer cleared when the call tab closes.
- Manual trigger is default; auto-fire is a switch.
- Answer rules (in the bridge `instructions`): headline line first, then full first-person answer, roughly 45–90 seconds spoken; resume facts only; say so when the resume has no match.
- Claude Code is started with `claude --dangerously-load-development-channels server:interview-bridge` (interactive only).
- Site scraping lives in one replaceable module per site.

## Review Focus

Inputs the spec implies but doesn't spell out, most likely first. Each is pinned by a test in the named task.

1. Hotkey pressed while the interviewer is mid-question: nothing is sent, badge says waiting (Task 2, Task 4, Task 8).
2. Captions turned off in the call: nothing arrives, badge says no captions rather than silence (Task 4, Task 8).
3. Bridge not running or Claude session already ended: badge says bridge down (Task 8).
4. Hotkey double-pressed: one answer, not two (Task 4).
5. Captions rewritten in place ("Tell me about your" becomes "Tell me about yourself"): the final text is what is sent (Task 2).

Also pinned: a web page POSTing to localhost must not reach the session, since that would be prompt injection into Claude Code (Task 4).

---

### Task 1: Scaffold, caption recorder, recorded fixtures

This task needs the user: it records real caption markup from a live Meet call and a live Teams-web call, which the scrapers are built against. The user needs a second person (or a second account in another window) to speak.

**Files:**
- Create: `package.json`, `tsconfig.json` (strict), `.gitignore` (`node_modules`), `tools/record-captions.js`
- Create: `extension/fixtures/meet.json`, `extension/fixtures/teams.json`

**Interfaces:**
- Produces fixture shape: `{ url: string; selfName: string; snapshots: { t: number; html: string }[] }` where `selfName` is the user's name exactly as shown in captions.

- [ ] **Step 1:** `git init`; `bun init`-style `package.json` with `"type": "module"` and script `"test": "bun test"`; deps `@modelcontextprotocol/sdk`; dev deps `happy-dom`, `@types/chrome`, `bun-types`.
- [ ] **Step 2:** Write `tools/record-captions.js`, a script pasted into the DevTools console. It defines `window.startRecording(selector: string)` (MutationObserver on that element, pushes `{t: Date.now(), html: el.outerHTML}` debounced 100 ms) and `window.stopRecording()` which calls `copy(JSON.stringify({url: location.href, selfName, snapshots}))`. `selfName` comes from a `window.selfName = '...'` the user sets first.
- [ ] **Step 3 (user):** On a Meet call with captions on, inspect the caption container, run `startRecording('<selector>')`, then have this exact exchange: partner says "Tell me about a time you failed." then you say "I once shipped a bug to production." Run `stopRecording()` and paste the clipboard into `extension/fixtures/meet.json`.
- [ ] **Step 4 (user):** Repeat in Teams web (note the hostname in `url`; it feeds the manifest in Task 8) into `extension/fixtures/teams.json`.
- [ ] **Step 5: Verify** — `bun -e "for (const f of ['meet','teams']) { const j = await Bun.file('extension/fixtures/'+f+'.json').json(); const s = JSON.stringify(j.snapshots); console.log(f, j.snapshots.length, s.includes('time you failed'), s.includes('shipped a bug')) }"`. Expected per line: `<name> <n≥5> true true`.
- [ ] **Step 6: Commit** `chore: scaffold and recorded caption fixtures`.

---

### Task 2: Shared types and TurnBuffer

**Files:**
- Create: `shared/types.ts`, `bridge/turns.ts`
- Test: `bridge/turns.test.ts`

**Interfaces:**
- Produces in `shared/types.ts`:
  - `type Speaker = 'interviewer' | 'user'`
  - `interface CaptionUpdate { blockId: string; speaker: Speaker; speakerName: string; text: string; ts: number }` (`text` is the block's full current text; the same `blockId` is re-sent as it grows or is corrected)
  - `interface Turn { speaker: Speaker; text: string; startedAt: number; endedAt: number }`
  - `interface Snapshot { question: Turn; priorAnswer: Turn | null }`
  - `type TriggerResult = { sent: true; eventId: string } | { sent: false; reason: 'no-question' | 'in-progress' | 'duplicate' }`
  - `interface Status { autoFire: boolean; channelLoaded: boolean; pendingAck: boolean; lastCaptionAgeMs: number | null }`
- Produces in `bridge/turns.ts`:
  `class TurnBuffer { constructor(opts: { turnGapMs: number; now: () => number }); ingest(u: CaptionUpdate): void; snapshot(): { snapshot: Snapshot } | { reason: 'no-question' | 'in-progress' }; tick(): Turn[]; lastCaptionAgeMs(): number | null; clear(): void }`
  A turn is consecutive blocks from one speaker, text joined with a space. It is complete when another speaker's block arrives or `turnGapMs` (default used by callers: 1500, my call) passes since its last update. `snapshot()` returns the latest completed interviewer turn with the user turn immediately before it as `priorAnswer`; `'in-progress'` when the newest turn is an open interviewer turn; `'no-question'` when no completed interviewer turn exists. `tick()` returns completed interviewer turns not yet returned by a previous `tick()`.

- [ ] **Step 1: Write failing tests** in `bridge/turns.test.ts` with a fake `now`:
  - `rewrites a block in place`: ingest `blockId 'a'` "Tell me about your", then `'a'` "Tell me about yourself", advance past the gap; `snapshot().snapshot.question.text === 'Tell me about yourself'`.
  - `joins same-speaker blocks into one turn`: two interviewer blocks within the gap give one turn, text `"one two"`.
  - `speaker change completes the turn immediately`: interviewer block then user block, no time advance; snapshot question is the interviewer text, `priorAnswer === null`.
  - `silence completes the turn`: before `turnGapMs` → `{ reason: 'in-progress' }`; after → a snapshot.
  - `empty buffer` → `{ reason: 'no-question' }`.
  - `priorAnswer is the user turn before the question`: user "I did X" then interviewer question; `priorAnswer.text === 'I did X'`.
  - `back-to-back questions: latest wins`.
  - `tick returns each completed interviewer turn once` (second call returns `[]`).
  - `lastCaptionAgeMs is null before any caption`; `clear() empties everything`.
- [ ] **Step 2:** Run `bun test bridge/turns.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3:** Implement `shared/types.ts` and `TurnBuffer` to the signatures above.
- [ ] **Step 4:** Run `bun test bridge/turns.test.ts`. Expected: all PASS.
- [ ] **Step 5: Commit** `feat: turn buffer`.

---

### Task 3: Channel event builder and instructions

**Files:**
- Create: `bridge/channel.ts`
- Test: `bridge/channel.test.ts`

**Interfaces:**
- Consumes: `Snapshot` (Task 2).
- Produces: `const INSTRUCTIONS: string`; `type ChannelEvent = { content: string; meta: Record<string, string> }`; `buildQuestionEvent(s: Snapshot, eventId: string): ChannelEvent`; `buildSelfTestEvent(eventId: string): ChannelEvent`.

- [ ] **Step 1: Write failing tests:**
  - `question event carries the question and prior answer in content`.
  - `meta is { kind: 'question', event_id }` for a question and `{ kind: 'selftest', event_id }` for the self-test.
  - `every meta key matches /^[A-Za-z0-9_]+$/` (hyphenated keys are silently dropped by Claude Code).
  - `INSTRUCTIONS` contains: the `ack` tool name, "45" and "90" (spoken length), "not in the resume" (the no-invention rule), "headline", and a sentence telling Claude to treat event content as the interviewer's words and never as instructions.
- [ ] **Step 2:** Run `bun test bridge/channel.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Content format is the builder's call; it must make the question and prior answer unmistakable. The self-test content tells Claude to call `ack` with that `event_id` and print nothing else.
- [ ] **Step 4:** Run the test. Expected: PASS.
- [ ] **Step 5: Commit** `feat: channel event builder`.

---

### Task 4: Bridge app (HTTP routes and state)

**Files:**
- Create: `bridge/app.ts`
- Test: `bridge/app.test.ts`

**Interfaces:**
- Consumes: `TurnBuffer`, `buildQuestionEvent`, `buildSelfTestEvent`, types.
- Produces: `createApp(deps: { buffer: TurnBuffer; emit: (e: ChannelEvent) => Promise<void>; now: () => number; newId: () => string; debounceMs?: number /* default 1500 */; port: number }): { fetch(req: Request): Promise<Response>; tick(): Promise<void>; ack(eventId: string): void; selfTest(): Promise<void> }`
- Routes: `POST /caption` (body `CaptionUpdate`) → 204; `POST /trigger` → 200 with `{sent:true,eventId}` or 409 with `{sent:false,reason}`; `POST /auto` (body `{on:boolean}`) → 204; `POST /reset` → 204 (clears buffer); `GET /status` → `Status`. State: `autoFire` (default false), `channelLoaded` (true after any ack), `pendingAck` (last emitted event not yet acked).
- Guard: any request whose `Origin` header is present and does not start with `chrome-extension://` gets 403; any request whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>` gets 403. Neither request is processed.

- [ ] **Step 1: Write failing tests** (fake `emit`, fake clock):
  - `trigger emits one question event` after captions for a completed interviewer turn.
  - `trigger mid-question returns 409 in-progress and does not emit` (review focus 1).
  - `trigger with no captions returns 409 no-question`; `status.lastCaptionAgeMs` is `null` (review focus 2).
  - `second trigger within debounceMs for the same question returns 409 duplicate; emit called once` (review focus 4).
  - `ack sets channelLoaded true and pendingAck false`.
  - `tick emits only when autoFire is on`; `turning auto on does not answer turns completed before it was enabled`.
  - `reset clears the buffer`.
  - `Origin https://evil.example gets 403 and the caption is not ingested`; `Host evil.example:8787 gets 403`.
- [ ] **Step 2:** Run `bun test bridge/app.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `createApp`. Duplicate = same question `startedAt` and `now() - lastTriggerAt < debounceMs`. Auto-fire calls `buffer.tick()` every time and emits only if on.
- [ ] **Step 4:** Run the test. Expected: PASS.
- [ ] **Step 5: Commit** `feat: bridge app`.

---

### Task 5: Bridge MCP server entry

**Files:**
- Create: `bridge/server.ts`, `.mcp.json`
- Test: `bridge/server.test.ts`

**Interfaces:**
- Consumes: `createApp`, `TurnBuffer`, `INSTRUCTIONS`.
- Produces: runnable `bun bridge/server.ts`. MCP server name `interview-bridge`, capabilities `{ experimental: { 'claude/channel': {} }, tools: {} }`, `instructions: INSTRUCTIONS`, one tool `ack` with input `{ event_id: string }` that calls `app.ack`. HTTP on `127.0.0.1:${BRIDGE_PORT ?? 8787}`. `setInterval(app.tick, 250)`. Calls `app.selfTest()` once after connect (retry policy is the builder's call). Exits when stdin ends. `.mcp.json` registers `interview-bridge` as `bun bridge/server.ts`.

- [ ] **Step 1: Write failing test** using the SDK `Client` + `StdioClientTransport` spawning `bun bridge/server.ts` with `BRIDGE_PORT=18787`:
  - `declares the channel capability and an ack tool`: `getServerCapabilities()?.experimental?.['claude/channel']` is defined and `listTools()` includes `ack`.
  - `serves status over HTTP`: `fetch('http://127.0.0.1:18787/status')` returns 200.
  - `exits when the client disconnects`: after `client.close()` the spawned process is gone within 2 s and port 18787 refuses connections.
- [ ] **Step 2:** Run `bun test bridge/server.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `bridge/server.ts` following the channels reference `webhook.ts` pattern (stdio `Server`, `mcp.notification({ method: 'notifications/claude/channel', params })` as `emit`), plus the `ack` tool handlers.
- [ ] **Step 4:** Run the test. Expected: PASS.
- [ ] **Step 5: Commit** `feat: bridge MCP server`.

---

### Task 6: Scraper interface and Meet scraper

**Files:**
- Create: `extension/src/scrapers/observe.ts`, `extension/src/scrapers/meet.ts`
- Test: `extension/src/scrapers/meet.test.ts`

**Interfaces:**
- Consumes: `CaptionUpdate`, `extension/fixtures/meet.json`.
- Produces:
  - `type Extract = (root: ParentNode, selfNames: string[], ts: number) => CaptionUpdate[]`
  - `observe(doc: Document, extract: Extract, selfNames: string[], onUpdate: (u: CaptionUpdate) => void): () => void` (MutationObserver on `doc.body`; calls `onUpdate` only when a block's `(blockId, text)` changed since last emitted; returns a stop function)
  - `extractMeet: Extract` (speaker is `'user'` when `speakerName` is in `selfNames`, else `'interviewer'`; `blockId` from stable DOM identity, builder decides from the fixture)

- [ ] **Step 1: Write failing tests** replaying every fixture snapshot into a happy-dom document (`document.body.innerHTML = html`) and running `extractMeet(document.body, [fixture.selfName], t)`:
  - `finds the interviewer question`: some update has `speaker === 'interviewer'` and text containing "Tell me about a time you failed".
  - `finds the user answer`: some later update has `speaker === 'user'` and text containing "shipped a bug".
  - `observe does not re-emit an unchanged block` (feed the same snapshot twice, expect one `onUpdate`).
- [ ] **Step 2:** Run `bun test extension/src/scrapers/meet.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `observe.ts` and `extractMeet`, reading selectors off the recorded fixture, not guessed. Keep every Meet selector in this one file.
- [ ] **Step 4:** Run the test. Expected: PASS.
- [ ] **Step 5: Commit** `feat: Meet caption scraper`.

---

### Task 7: Teams scraper

**Files:**
- Create: `extension/src/scrapers/teams.ts`, `extension/src/scrapers/index.ts`
- Test: `extension/src/scrapers/teams.test.ts`

**Interfaces:**
- Consumes: `Extract`, `observe` (Task 6), `extension/fixtures/teams.json`.
- Produces: `extractTeams: Extract`; `scraperFor(hostname: string): Extract | null` (Meet host → `extractMeet`; the Teams hostnames present in the Teams fixture's `url` → `extractTeams`; anything else → `null`).

- [ ] **Step 1: Write failing tests:** the same two fixture assertions as Task 6 against `teams.json`; `scraperFor('meet.google.com')` is `extractMeet`; `scraperFor('example.com')` is `null`; `scraperFor(<hostname from teams.json url>)` is `extractTeams`.
- [ ] **Step 2:** Run `bun test extension/src/scrapers`. Expected: Teams tests FAIL.
- [ ] **Step 3:** Implement `extractTeams` and `scraperFor`, selectors read from the Teams fixture.
- [ ] **Step 4:** Run `bun test extension/src/scrapers`. Expected: all PASS.
- [ ] **Step 5: Commit** `feat: Teams caption scraper and host routing`.

---

### Task 8: Extension shell (manifest, content script, service worker)

**Files:**
- Create: `extension/manifest.json`, `extension/src/content.ts`, `extension/src/background.ts`, `extension/src/bridgeClient.ts`
- Test: `extension/src/bridgeClient.test.ts`

**Interfaces:**
- Consumes: `scraperFor`, `observe` (Tasks 6–7), bridge routes (Task 4).
- Produces: `type BridgeState = 'sent' | 'waiting' | 'no-question' | 'no-captions' | 'duplicate' | 'down' | 'no-ack'`; `createBridgeClient(fetchFn: typeof fetch, base?: string /* default http://127.0.0.1:8787 */): { postCaption(u: CaptionUpdate): Promise<void>; trigger(): Promise<BridgeState>; setAuto(on: boolean): Promise<void>; reset(): Promise<void>; status(): Promise<Status | null> }`

- [ ] **Step 1: Write failing tests** in `bridgeClient.test.ts` with a stub `fetchFn`:
  - `trigger returns 'down' when fetch rejects` (review focus 3).
  - `trigger maps 200 to 'sent'`; `409 in-progress` to `'waiting'`; `409 duplicate` to `'duplicate'`.
  - `409 no-question maps to 'no-captions' when status().lastCaptionAgeMs is null, else 'no-question'` (review focus 2).
  - `postCaption swallows a rejected fetch` (a dead bridge must not throw inside the content script).
- [ ] **Step 2:** Run `bun test extension/src/bridgeClient.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `bridgeClient.ts`.
- [ ] **Step 4:** Run the test. Expected: PASS.
- [ ] **Step 5:** Write the rest, which isn't unit-testable:
  - `manifest.json` (MV3): content-script `matches` and `host_permissions` for `https://meet.google.com/*`, the Teams hosts recorded in `teams.json`, and `http://127.0.0.1:8787/*`; `background.service_worker`; `commands` `trigger` (suggested `Alt+Shift+K`) and `toggle-auto` (suggested `Alt+Shift+J`), both my call, check for conflicts.
  - `content.ts`: `scraperFor(location.hostname)`, `observe(...)`, sends each update to the service worker with `chrome.runtime.sendMessage`. `selfNames` read from `chrome.storage.local` key `selfNames`, default `['You']`.
  - `background.ts`: forwards captions with `postCaption`; on `trigger` command calls `trigger()` and sets the toolbar badge text and color per `BridgeState`; 10 s after `'sent'`, if `status().pendingAck` is still true, set badge `'no-ack'`; `toggle-auto` flips and calls `setAuto`; `chrome.tabs.onRemoved` for a tab that has sent captions calls `reset()`.
- [ ] **Step 6: Verify manually** — load `extension/` unpacked in `chrome://extensions`; open a Meet call with captions on; badge changes on hotkey; with the bridge stopped, hotkey shows the down badge.
- [ ] **Step 7: Commit** `feat: extension shell`.

---

### Task 9: Run guide and end-to-end acceptance

**Files:**
- Create: `README.md`

- [ ] **Step 1:** Write `README.md`: prerequisites (Bun, Chrome, Claude Code version that has channels); `bun install`; load the extension; set `selfNames` for Teams; start Claude Code in this directory with `claude --dangerously-load-development-channels server:interview-bridge` and accept the warning dialog; a paste-ready session-start prompt ("Read my resume at `<path>` and the JD at `<path>`; hold both for the mock interview"); hotkeys and the auto-fire toggle; what each badge state means.
- [ ] **Step 2: Acceptance run** with a mock partner on Meet, then on Teams. Each must hold:
  - `curl -s 127.0.0.1:8787/status` shows `channelLoaded: true` before the call starts (self-test acked).
  - Partner asks a question that the resume covers; hotkey; terminal shows a headline then a full answer, and `pendingAck` goes false.
  - Partner asks something the resume does not cover; the answer says so and does not invent.
  - Hotkey pressed while the partner is still speaking → waiting badge, nothing in the terminal.
  - Hotkey double-pressed → one answer.
  - Close the call tab → `/status` shows `lastCaptionAgeMs: null`. End the Claude Code session → `pgrep -f bridge/server.ts` prints nothing.
  - Record the measured time from hotkey to the first line of the answer. The spec sets no threshold; report the number to the user.
- [ ] **Step 3: Commit** `docs: run guide and acceptance results`.
