// extension/src/bridgeClient.ts
var JSON_POST = { method: "POST", headers: { "content-type": "application/json" } };
function createBridgeClient(fetchFn, base = "http://127.0.0.1:8787") {
  const root = base.replace(/\/+$/, "");
  const post = async (path, body) => {
    try {
      const res = await fetchFn(`${root}${path}`, body === undefined ? { method: "POST" } : { ...JSON_POST, body: JSON.stringify(body) });
      if (!res.ok)
        console.error(`bridge ${path} answered ${res.status}`);
    } catch (err) {
      console.error(`bridge ${path} unreachable`, err);
    }
  };
  const status = async () => {
    try {
      const res = await fetchFn(`${root}/status`);
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  };
  const trigger = async () => {
    try {
      const res = await fetchFn(`${root}/trigger`, { method: "POST" });
      if (res.status === 200)
        return "sent";
      if (res.status !== 409)
        return "down";
      const reason = (await res.json()).reason;
      if (reason === "in-progress")
        return "waiting";
      if (reason === "duplicate")
        return "duplicate";
      if (reason !== "no-question")
        return "down";
      return (await status())?.lastCaptionAgeMs === null ? "no-captions" : "no-question";
    } catch {
      return "down";
    }
  };
  const capture = async (p) => {
    try {
      const res = await fetchFn(`${root}/capture`, { ...JSON_POST, body: JSON.stringify(p) });
      return res.status === 200 ? "sent" : "down";
    } catch {
      return "down";
    }
  };
  return {
    postCaption: (u, tabId) => post("/caption", { ...u, tabId }),
    trigger,
    capture,
    setAuto: (on) => post("/auto", { on }),
    reset: (tabId) => post("/reset", tabId === undefined ? undefined : { tabId }),
    focus: (tabId) => post("/focus", { tabId }),
    status
  };
}

// extension/src/controller.ts
function createController(deps) {
  const { client, setBadge, storage, schedule } = deps;
  const ackTimeoutMs = deps.ackTimeoutMs ?? 1e4;
  let tabsQueue = Promise.resolve();
  const withTabs = (fn) => {
    const run = tabsQueue.then(fn);
    tabsQueue = run.catch(() => {});
    return run;
  };
  const badge = async (state) => {
    try {
      await setBadge(state);
    } catch (err) {
      console.error("setBadge failed", err);
    }
  };
  const afterSend = async (state) => {
    await badge(state);
    if (state !== "sent")
      return;
    schedule(async () => {
      if ((await client.status())?.pendingAck === true)
        await badge("no-ack");
    }, ackTimeoutMs);
  };
  return {
    async onCaption(tabId, update) {
      await client.postCaption(update, tabId);
      try {
        await withTabs(async () => {
          const tabs = await storage.getTabs();
          if (!tabs.includes(tabId))
            await storage.setTabs([...tabs, tabId]);
        });
      } catch (err) {
        console.error("remembering caption tab failed", err);
      }
    },
    onFocus: (tabId) => client.focus(tabId),
    onTrigger: async () => afterSend(await client.trigger()),
    onCapture: async (p) => afterSend(await client.capture(p)),
    async onToggleAuto() {
      const before = await client.status();
      if (!before)
        return badge("down");
      await client.setAuto(!before.autoFire);
      const after = await client.status();
      return badge(after ? after.autoFire ? "auto-on" : "auto-off" : "down");
    },
    async onTabRemoved(tabId) {
      const known = await withTabs(async () => {
        const tabs = await storage.getTabs();
        if (!tabs.includes(tabId))
          return false;
        await storage.setTabs(tabs.filter((t) => t !== tabId));
        return true;
      });
      if (known)
        await client.reset(tabId);
    }
  };
}

// extension/src/capture.ts
var PNG_PREFIX = "data:image/png;base64,";
var MAX_FRAME_CHARS = 50000;
function buildPayload(tab, dataUrl, frames) {
  if (!dataUrl.startsWith(PNG_PREFIX))
    throw new Error("screenshot is not a png data url");
  const text = frames.filter((f) => f.text !== "").map((f) => `## frame: ${f.url}
${f.text.slice(0, MAX_FRAME_CHARS)}`).join(`

`);
  return { url: tab.url ?? "", title: tab.title ?? "", text, png: dataUrl.slice(PNG_PREFIX.length) };
}

// extension/src/background.ts
var GREEN = "#2e7d32";
var AMBER = "#f9a825";
var RED = "#c62828";
var BADGES = {
  sent: { text: "SENT", color: GREEN },
  "auto-on": { text: "AUTO", color: GREEN },
  waiting: { text: "WAIT", color: AMBER },
  "no-question": { text: "NOQ", color: AMBER },
  "no-captions": { text: "NOCC", color: AMBER },
  duplicate: { text: "DUP", color: AMBER },
  down: { text: "DOWN", color: RED },
  "no-ack": { text: "NOAK", color: RED },
  "auto-off": { text: "", color: GREEN }
};
var TABS = "tabs";
var showBadge = async (state) => {
  const b = state === "" ? BADGES["auto-off"] : BADGES[state];
  await chrome.action.setBadgeText({ text: b.text });
  await chrome.action.setBadgeBackgroundColor({ color: b.color });
};
var controller = createController({
  client: createBridgeClient(fetch),
  setBadge: showBadge,
  storage: {
    getTabs: async () => (await chrome.storage.session.get(TABS))[TABS] ?? [],
    setTabs: (tabs) => chrome.storage.session.set({ [TABS]: tabs })
  },
  schedule: (fn, ms) => void setTimeout(fn, ms)
});
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== "caption" || !msg.update || sender.tab?.id === undefined)
    return false;
  controller.onCaption(sender.tab.id, msg.update).catch(console.error);
  return false;
});
async function captureActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id === undefined)
    return;
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  } catch {
    return showBadge("down");
  }
  let frames = [];
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => ({ url: location.href, text: document.body?.innerText ?? "" })
    });
    frames = results.flatMap((r) => r.result ? [r.result] : []);
  } catch {}
  await controller.onCapture(buildPayload(tab, dataUrl, frames));
}
async function syncFocus() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id !== undefined)
    await controller.onFocus(tab.id);
}
chrome.tabs.onActivated.addListener(() => void syncFocus().catch(console.error));
chrome.windows.onFocusChanged.addListener(() => void syncFocus().catch(console.error));
syncFocus().catch(console.error);
chrome.runtime.onInstalled.addListener(async () => {
  const matches = chrome.runtime.getManifest().content_scripts?.flatMap((c) => c.matches ?? []) ?? [];
  for (const tab of await chrome.tabs.query({ url: matches })) {
    if (tab.id !== undefined)
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["dist/content.js"] }).catch(console.error);
  }
});
chrome.commands.onCommand.addListener((command) => {
  if (command === "trigger")
    syncFocus().then(() => controller.onTrigger()).catch(console.error);
  else if (command === "capture")
    captureActiveTab().catch(console.error);
  else if (command === "toggle-auto")
    controller.onToggleAuto().catch(console.error);
});
chrome.tabs.onRemoved.addListener((tabId) => controller.onTabRemoved(tabId).catch(console.error));
