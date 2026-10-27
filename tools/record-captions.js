// Paste this whole file into the DevTools console of a Meet / Teams-web call tab.
// 1. Turn captions on, inspect the caption container, copy a CSS selector for it.
// 2. window.selfName = 'Your Name'   (exactly as shown in captions)
// 3. startRecording('<selector>')    then run the scripted exchange
// 4. stopRecording()                 JSON is now on your clipboard; paste into the fixture file.
(() => {
  let snapshots = [];
  let observer = null;
  let timer = null;

  window.startRecording = (selector) => {
    const el = document.querySelector(selector);
    if (!el) throw new Error('no element for selector: ' + selector);
    snapshots = [];
    observer?.disconnect();
    const snap = () => snapshots.push({ t: Date.now(), html: el.outerHTML });
    observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(snap, 100);
    });
    observer.observe(el, { subtree: true, childList: true, characterData: true, attributes: true });
    snap();
    console.log('recording', selector);
  };

  window.stopRecording = () => {
    observer?.disconnect();
    observer = null;
    clearTimeout(timer);
    const selfName = window.selfName;
    if (!selfName) console.warn('window.selfName not set; fixture will have selfName undefined');
    copy(JSON.stringify({ url: location.href, selfName, snapshots }));
    console.log('copied', snapshots.length, 'snapshots');
  };
})();
