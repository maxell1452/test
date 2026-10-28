// extension/src/scrapers/observe.ts
function observe(doc, findRoot, extract, selfNames, onUpdate, opts = {}) {
  const emitted = new Map;
  let observer = null;
  let current = null;
  let stopped = false;
  const scan = (root) => {
    if (stopped)
      return;
    for (const u of extract(root, selfNames, Date.now())) {
      if (emitted.get(u.blockId) === u.text)
        continue;
      emitted.set(u.blockId, u.text);
      onUpdate(u);
    }
  };
  const attach = () => {
    const root = findRoot(doc);
    if (root === current)
      return;
    observer?.disconnect();
    observer = null;
    current = root;
    if (!root)
      return;
    observer = new doc.defaultView.MutationObserver(() => scan(root));
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    scan(root);
  };
  attach();
  const timer = setInterval(attach, opts.recheckMs ?? 1e4);
  return () => {
    stopped = true;
    clearInterval(timer);
    observer?.disconnect();
  };
}

// extension/src/scrapers/teams.ts
var BLOCK = ".fui-ChatMessageCompact";
var AUTHOR = '[data-tid="author"]';
var TEXT = '[data-tid="closed-caption-text"]';
var AVATAR = 'span[role="img"][id^="avatar-"]';
var STAMP = "data-caption-id";
var ROOTS = [
  '[data-tid="closed-caption-renderer-wrapper"]',
  '[data-tid="closed-caption-v2-window-wrapper"]',
  '[data-tid="closed-captions-renderer"]'
];
var ANY_CAPTION_TID = '[data-tid*="closed-caption"]';
function findTeamsCaptionRoot(doc) {
  for (const selector of ROOTS) {
    const el = doc.querySelector(selector);
    if (el)
      return el;
  }
  let root = null;
  let hop = doc.querySelector(TEXT)?.parentElement?.closest(ANY_CAPTION_TID);
  while (hop) {
    root = hop;
    hop = hop.parentElement?.closest(ANY_CAPTION_TID);
  }
  return root;
}
var extractTeams = (root, selfNames, ts) => {
  const updates = [];
  for (const block of Array.from(root.querySelectorAll(BLOCK))) {
    const text = block.querySelector(TEXT)?.textContent?.trim();
    const speakerName = block.querySelector(AUTHOR)?.textContent?.trim();
    if (!text || !speakerName)
      continue;
    const blockId = block.querySelector(AVATAR)?.id || block.getAttribute(STAMP) || stamp(block);
    updates.push({ blockId, speaker: selfNames.includes(speakerName) ? "user" : "interviewer", speakerName, text, ts });
  }
  return updates;
};
function stamp(block) {
  const id = `caption-${crypto.randomUUID()}`;
  block.setAttribute(STAMP, id);
  return id;
}

// extension/src/scrapers/index.ts
var TEAMS_HOSTS = ["teams.microsoft.com", "teams.cloud.microsoft", "teams.live.com"];
var TEAMS = { findRoot: findTeamsCaptionRoot, extract: extractTeams };
function scraperFor(hostname) {
  return TEAMS_HOSTS.includes(hostname) ? TEAMS : null;
}

// extension/src/content.ts
var scraper = scraperFor(location.hostname);
if (scraper) {
  let stop = () => {};
  const start = (selfNames) => {
    stop();
    stop = observe(document, scraper.findRoot, scraper.extract, selfNames, (update) => {
      try {
        chrome.runtime.sendMessage({ type: "caption", update }).catch(() => {});
      } catch {}
    });
  };
  const names = (v) => Array.isArray(v) && v.every((n) => typeof n === "string") && v.length ? v : ["You"];
  chrome.storage.local.get("selfNames").then((r) => start(names(r.selfNames)), () => start(["You"]));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.selfNames)
      start(names(changes.selfNames.newValue));
  });
}
