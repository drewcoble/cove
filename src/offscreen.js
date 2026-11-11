// Offscreen documents never have focus, so navigator.clipboard is unavailable here;
// execCommand('copy') on a selected textarea is the supported route.
// Only the service worker may ask for a copy; content scripts can message extension pages too.
const SERVICE_WORKER = chrome.runtime.getURL('src/background.js');

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.url !== SERVICE_WORKER || msg?.target !== 'offscreen' || msg.type !== 'copy') return;
  const area = document.createElement('textarea');
  area.value = msg.text;
  document.body.append(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  sendResponse({ ok });
});
