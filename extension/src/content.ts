import { observe } from './scrapers/observe';
import { scraperFor } from './scrapers';

// Runs in the page: no fetch here (it would carry the page's origin). Captions go to the service worker only.
const scraper = scraperFor(location.hostname);

if (scraper) {
  let stop = () => {};

  const start = (selfNames: string[]) => {
    stop();
    stop = observe(
      document,
      scraper.findRoot,
      scraper.extract,
      selfNames,
      (update) => {
        // Never let a failure reach the page. Log it, or a dead pipe looks exactly like "no captions".
        try {
          chrome.runtime
            .sendMessage({ type: 'caption', update })
            .catch((err) => console.warn('[interview-copilot] caption not delivered', err));
        } catch (err) {
          // "Extension context invalidated": the extension was reloaded and this script is an orphan.
          // The worker re-injects a fresh copy (background.ts onInstalled), so stop instead of failing on every caption.
          console.warn('[interview-copilot] extension reloaded, this tab script stops', err);
          stop();
        }
      },
    );
  };

  const DEFAULT_NAMES = [
    'Vuong',
    'Vuong Vu Hoang',
    'Vuong Vu',
    'Vương',
    'Vương Vũ Hoàng',
    'Vương Vũ',
    'You', // Meet labels your own captions "You" ("Bạn" in the Vietnamese UI) whatever your display name is
    'Bạn',
  ]; // used until selfNames is set in storage
  const names = (v: unknown): string[] =>
    Array.isArray(v) && v.every((n) => typeof n === 'string') && v.length
      ? v
      : DEFAULT_NAMES;

  chrome.storage.local.get('selfNames').then(
    (r) => start(names(r.selfNames)),
    () => start(DEFAULT_NAMES),
  );
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.selfNames)
      start(names(changes.selfNames.newValue));
  });
}
