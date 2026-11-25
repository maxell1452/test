# Mock Interview Copilot — Design

Status: draft for approval. Nothing is built.
Convention: "Decided" = said by the user. "My call" = chosen by the author, not agreed to, open to override.

## Intent

The user practises interviews by running mock interviews on Google Meet or Microsoft Teams with a partner playing the interviewer. They want Claude (their running Claude Code session) to hear the interviewer's questions live and put a full, ready-to-read model answer in the terminal, built from the user's own resume and the target job description (JD).

Why this shape: the user already lives in Claude Code, and the call lives in the browser. A Chrome extension captures the captions, a local bridge pushes them into the session, and the answer appears where the user already works.

## Goals

- During a live Meet or Teams mock call, the user presses a hotkey in the browser and a model answer to the interviewer's latest question appears in the Claude Code terminal. (Decided)
- The answer is a full, first-person, speakable answer, not bullet cues. (Decided)
- The answer is grounded in the resume and aimed at the JD. (Decided: resume + JD are the inputs.)
- Both Google Meet and Microsoft Teams (web client, in Chrome) work in the first version. Meet-first is not acceptable. (Decided)
- Auto-answer when the interviewer stops talking exists as a switch; manual trigger is the default. (Decided)
- The tool's lifetime is the session: it stops when the Claude Code session ends or the meeting tab closes. Nothing persists between mocks. (Decided)

## Non-goals

- Persisting transcripts, answers or history across sessions. (Decided by the lifetime above)
- Post-call review or scoring. Not requested; a possible later project.
- Support for browsers other than Chrome, or for the Teams/Meet desktop apps. (The user confirmed they use Teams in the browser; an extension cannot see the desktop app.)
- Any use in real interviews. This is built and tested for mock calls only. (My call)
- A UI on the call page itself. Output goes to the terminal only. (Decided)

## Anti-goals (a failure even if it technically works)

- The suggested answer arrives after the user has already had to start answering. Latency is the central quality bar. (My call; the user was not asked for a number.)
- Claude invents experience that is not in the resume and the user reads it aloud as theirs. If the resume has nothing relevant, Claude says so and gives the closest honest angle. Hard rule. (My call)
- Half-formed questions get answered because a hotkey was pressed mid-sentence. (My call)
- Events silently vanish with no sign anything is wrong. (My call; see Constraints.)

## How it works

1. **Extension (Chrome, Manifest V3, TypeScript — my call).** Content scripts on Meet and Teams-web read the live captions from the page, tag each line with speaker (interviewer or user), and group lines into completed speaker turns. A service worker forwards turns to the bridge over localhost. A hotkey command triggers an answer.
2. **Bridge (local process, Bun/TypeScript — my call).** One process that is both an MCP server over stdio, spawned by Claude Code, and a localhost-only HTTP listener for the extension. It buffers completed turns. On trigger (or on auto-fire) it emits one `notifications/claude/channel` event containing the interviewer's latest completed turn plus the user's previous answer as context. It listens on 127.0.0.1 only.
3. **Claude Code session.** Started interactively with `claude --dangerously-load-development-channels server:<bridge-name>` (custom channels are not on the research-preview allowlist; a warning dialog must be accepted; the flag is ignored in `-p`/SDK mode — verified in the channels reference). On session start the user gives Claude the resume and JD (file paths — my call). The bridge's `instructions` field tells Claude how to answer: headline line first, then the full answer; resume facts only; spoken length of roughly 45–90 seconds (my call); say so when the resume has no match.
4. **Auto-fire (switch).** When on, the bridge emits the event when the interviewer's turn completes instead of waiting for the hotkey.

Transport facts verified in the Claude Code docs (channels reference): a server declaring the `claude/channel` experimental capability can push events into a session; the user opts in with `--channels`; Claude Code does not acknowledge events and drops them silently if the server is not loaded as a channel or policy blocks it; events that arrive while Claude is mid-reply are queued and delivered together on the next turn.

Fallback if channels are unavailable: Claude Code's Monitor tool can consume a WebSocket (needs v2.1.195 or later) or a script's stdout, one event per frame or line. Each watch is capped at 30 minutes and must be re-armed. Acceptable for a mock call, not elegant.

## Constraints

- Runs on the user's machine (Linux, Chrome). Bridge binds to 127.0.0.1 only; transcripts never leave the machine except through the user's own Claude session.
- Depends on Meet and Teams captions being switched on in the call and being readable from the page. Both are scraped from the page structure, which the vendors can change at any time. The scrape logic must live in one small, replaceable module per site.
- Channel events can be dropped silently, so the bridge needs a visible "connected / channel loaded" signal for the user. A hotkey press that produces nothing must not be indistinguishable from a bug.
- Not verified yet and not to be assumed: how Meet and Teams-web mark turn boundaries in captions, whether a content script's request to a localhost HTTP URL works from an https page (the service worker is the likely route), whether the development-channels flag is available on the user's account and version, and what hotkey scope Chrome allows when the call tab is focused.

## Left to the builder

- Exact turn-boundary heuristic, buffer sizes, and the shape of the event payload.
- Hotkey choice and how the user toggles auto-fire.
- How the user tells the bridge/session which resume and JD to use, as long as it is quick to do at session start.
- Prompt wording in the bridge `instructions`, within the rules above.
- Project layout, build tooling, and test approach. A first step that records real caption DOM from a Meet call and a Teams-web call before designing the scraper is strongly recommended.

## Open items for the user

None blocking. The "my call" items above are the ones to check while reading.
Because both sites are required at launch, the two site-specific scrapers are built behind one shared interface (speaker, text, turn-complete) so the bridge and Claude side never know which site is in use.
