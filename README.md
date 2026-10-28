# Mock Interview Copilot

During a **mock interview with a partner**, a Chrome extension reads the live captions from Microsoft Teams (web), a small local bridge passes the interviewer's latest question into your running Claude Code session, and Claude prints a one-line headline plus a full first-person answer (about 45–90 seconds spoken) built only from your resume and aimed at the job description.

```
Teams-web tab                Chrome extension                  Bridge (Bun)                 Claude Code
live captions ──scrape──▶ content script ──message──▶ service worker ──HTTP──▶ 127.0.0.1:8787 ──channel event──▶ your session
                                                       (Alt+Shift+K)              (also an MCP server)           headline + answer in the terminal
```

## Status — read this first

| Piece | State |
|---|---|
| Bridge, MCP channel, turn buffer | Built, unit-tested, smoke-tested |
| Teams-web scraper + extension shell | Built, unit-tested against **one recorded call**. **Never run in real Chrome/Teams/Claude yet** — section 5 is the acceptance test |
| Google Meet | **Not built.** There is no recorded Meet caption fixture, and the scraper must be written against real markup, not guessed |
| Auto-fire (answer without pressing a key) | Built, off by default. Alt+Shift+J toggles it |

Use it for **mock interviews with someone you trust only.** The interviewer's speech goes straight into Claude's context. The bridge wraps it in delimiters and tells Claude to treat it as speech, but the delimiters can be forged by whoever is speaking, and the bridge accepts requests from any Chrome extension on your machine. Do not point it at a real interview.

## 1. Requirements

- Linux, Google Chrome (no other browser is supported)
- [Bun](https://bun.sh) (the bridge and the build both run on it)
- A Claude Code build that supports development channels: `claude --help` must list `--dangerously-load-development-channels`
- A partner and a Teams meeting you can both join in the browser (teams.microsoft.com, teams.cloud.microsoft or teams.live.com)

## 2. Setup (once)

```bash
curl -fsSL https://bun.sh/install | bash     # then open a new shell; `bun --version` must work
git clone <this repo> && cd interview-prep   # or just cd into it
bun install
bun run build                                # writes extension/dist/content.js and background.js
```

Load the extension:

1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked** → choose the `extension/` folder (not `extension/dist`).
3. Open `chrome://extensions/shortcuts`. Under *Interview Copilot*, both **Alt+Shift+K** (send question) and **Alt+Shift+J** (toggle auto-fire) must show as bound. Chrome silently leaves a shortcut unset if another extension already owns it; set it by hand there.
4. **Tell it your name.** The extension tells your lines from the interviewer's by an exact match on your display name as Teams shows it in captions. The default is `You`, which matches nothing in Teams, so until you set this **every line counts as the interviewer's**.
   - On `chrome://extensions`, under *Interview Copilot*, click **service worker** (opens DevTools), go to the Console and run:
   ```js
   chrome.storage.local.set({ selfNames: ['Your Name As Shown In Teams'] })
   ```
   - Take the name from a caption line you speak, not from your profile. A tab that is already open picks the change up without a reload.

After rebuilding (`bun run build`), click the reload arrow on the extension card.

## 3. Check it works without a call (2 minutes)

```bash
bun test              # unit tests, replayed against the recorded Teams captions
bun run typecheck     # strict TypeScript
bun run smoke         # real bridge over MCP, fixture replayed into it, question delivered
```

`bun run smoke` starts its own bridge on port 18789 (never 8787), replays the recorded Teams call through the real scraper into it, fires a trigger and checks the question arrives, then checks the origin guard (a `chrome-extension://` origin is allowed, a web page origin gets 403, a wrong `Host` gets 403). It prints one `PASS`/`FAIL` line per check and exits non-zero on any failure. This covers everything except Chrome and Claude themselves.

## 4. Run a mock interview

1. **Put your resume and the job description in files** you can point to, e.g. `~/prep/resume.md` and `~/prep/jd.md` (text or markdown; the Claude session must be able to read them).
2. **Start Claude Code from this repo's root** (that is where `.mcp.json` registers the bridge):
   ```bash
   claude --dangerously-load-development-channels server:interview-bridge
   ```
   Interactive mode only. Accept the warning dialog. Only one session can hold the bridge at a time (port 8787); see Troubleshooting.
3. **First message in the session:**
   > Read my resume at `~/prep/resume.md` and the job description at `~/prep/jd.md`. You are my live mock-interview copilot: when `interview-bridge` channel events arrive, follow the channel instructions. Confirm once you have read both.
4. **Confirm the channel is live** in another terminal:
   ```bash
   curl -s 127.0.0.1:8787/status
   ```
   `"channelLoaded": true` means Claude acknowledged the startup self-test. If it stays `false`, Claude is not receiving events: see Troubleshooting.
5. **Join the Teams meeting** in Chrome with your partner and **turn on live captions** (More → Captions). Captions must be on, in English.
6. The partner asks a question. When they stop speaking, wait about 2 seconds for the turn to close, then press **Alt+Shift+K with the Chrome window focused**. Chrome shortcuts are not global: pressed with the terminal focused, nothing happens. Keep the terminal visible beside Chrome.
7. The badge on the extension icon shows what happened (table below) and Claude prints the headline and answer in the terminal.
8. Close the Teams tab or end the Claude session when finished. Nothing is saved anywhere; the bridge and its buffers die with the session.

**Auto-fire (optional):** Alt+Shift+J turns it on (badge `AUTO`). The bridge then sends each completed interviewer turn itself. Expect it to fire on pauses mid-question, because captions split sentences; manual is more reliable.

### Hotkeys and badge

| Key (Chrome focused) | Action |
|---|---|
| Alt+Shift+K | Send the interviewer's latest question to Claude |
| Alt+Shift+J | Toggle auto-fire |

| Badge | Colour | Meaning |
|---|---|---|
| `SENT` | green | Question delivered to the session |
| `AUTO` | green | Auto-fire is on |
| `WAIT` | amber | The interviewer is still speaking; press again in a moment |
| `NOQ` | amber | Captions are arriving but there is no completed interviewer turn yet |
| `NOCC` | amber | The bridge has seen no captions at all: captions are off, or the scraper found nothing |
| `DUP` | amber | That question was already sent |
| `NOAK` | red | Sent, but Claude did not acknowledge within 10 s: the channel is not loaded or Claude is stuck |
| `DOWN` | red | The bridge is unreachable (or answered with an unexpected error): see Troubleshooting |

## 5. Acceptance test (what to verify by hand)

Nothing below has been run yet. Do it once with your partner and tick it off.

**Extension and bridge** (start a Claude session as in section 4 first: the bridge runs inside it and exits when the session ends, so there is no way to run it on its own)
- [ ] Load unpacked shows no manifest errors; the service worker starts; both shortcuts are bound.
- [ ] In a Teams call with captions on, `curl -s 127.0.0.1:8787/status` shows `lastCaptionAgeMs` small and changing while someone talks.
- [ ] With `selfNames` set, your own lines are *not* sent as questions; the partner's are.
- [ ] Toggle captions off and on, or close and reopen the captions panel: capture resumes within about 10 s.
- [ ] Leave Chrome idle for a few minutes so the service worker sleeps, then talk: captions still flow, and closing the Teams tab still resets the bridge (`lastCaptionAgeMs` returns to `null`). Closing an unrelated tab must *not* reset it.
- [ ] With the Claude session closed (bridge gone): Alt+Shift+K shows red `DOWN` and the page console shows no uncaught errors.

**With a Claude session**
- [ ] `channelLoaded: true` shortly after start.
- [ ] Partner asks "Tell me about a time you failed." → Alt+Shift+K → green `SENT`; Claude prints a headline and a first-person answer drawn from your resume; badge does not turn `NOAK`.
- [ ] Ask something your resume cannot answer: Claude says so instead of inventing.
- [ ] Press the key while the partner is mid-sentence → `WAIT`; press twice in a row → `DUP`.
- [ ] Alt+Shift+J → `AUTO`, and the next completed interviewer turn is answered without a key press.
- [ ] Measure and write down the delay from the end of the question to the first line of the answer (the design sets no target).

## 6. Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| Claude shows `interview-bridge` failed to connect (`ENOENT … bun`) | `bun` is not on the PATH of the shell that started Claude. Fix the PATH, or put the absolute path (e.g. `/home/you/.bun/bin/bun`) in `.mcp.json` |
| `interview-bridge` fails to connect, or `curl 127.0.0.1:8787/status` answers but is not yours | Another Claude session in this repo already holds port 8787 (any session started here loads `.mcp.json`). Close it. `BRIDGE_PORT` exists for tests but the extension is hardcoded to 8787, so do not change it for real use |
| `channelLoaded` stays `false` | Claude was not started with `--dangerously-load-development-channels server:interview-bridge`, or you did not accept the dialog, or you are in a non-interactive session |
| Badge `DOWN` while the bridge is running | The extension treats any unexpected HTTP error as down, including a 403. Check: `curl -si -X POST 127.0.0.1:8787/trigger`. A 409 JSON body means the bridge is fine |
| Badge `NOCC` | Captions are off, are not English, or the scraper found no caption container (Teams changed its markup, or you are on a host or layout it does not know). Check the page console and the service worker console for errors |
| Every caption counts as the interviewer | `selfNames` is not set, or does not match the name Teams shows in the captions exactly (section 2, step 4) |
| Question arrives garbled or twice | Teams' speech recognition splits one sentence into several blocks and misspells words; a Teams reload also gives blocks new ids. Re-ask more slowly, or press Alt+Shift+K after the partner has been quiet for 2 s |
| Alt+Shift+K does nothing | Chrome is not the focused window, or another extension owns the shortcut: check `chrome://extensions/shortcuts` |

## 7. How it is built

```
bridge/        MCP server + HTTP app + turn buffer (Bun)           bridge/server.ts is what .mcp.json runs
extension/     MV3 extension: manifest.json, src/ → dist/ (bun build)
  src/scrapers/  observer + Teams caption scraper
  src/controller.ts  badge, no-ack check, reset-on-tab-close (unit-tested core of the service worker)
shared/        types shared by both sides
tools/         record-captions.js (fixture recorder), smoke.ts (bridge smoke test)
docs/          design spec and implementation plan
```

- Captions are posted from the **extension service worker**, never from the page: a content script's requests carry the page's origin, which the bridge refuses.
- The bridge only listens on `127.0.0.1`, rejects any `Origin` that is not `chrome-extension://…`, and checks the `Host` header.
- Meet support needs a recorded fixture first. To record one: open a call with a second participant, turn captions on, paste `tools/record-captions.js` into the DevTools console, set `window.selfName`, run `startRecording('<caption container selector>')`, speak the scripted exchange, wait a second, run `stopRecording()`, and save the clipboard as `extension/fixtures/meet.json`.

## 8. Known limits

- Teams captions are the speech recogniser's output: expect misheard words and fragmented sentences.
- Teams-only, Linux, Chrome-only. Meet is not implemented.
- The scraper was written against one recording of the 2026 Teams layout. Older layouts, other tenants and other Teams hosts are unverified.
- The extension has no settings page: `selfNames` is set from the service-worker console.
- Security: see the warning under Status. Delimiter forging and the any-extension origin check are known and unfixed.
