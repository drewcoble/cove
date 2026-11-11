// Offscreen documents never have focus, so navigator.clipboard is unavailable here;
// execCommand('copy') on a selected textarea is the supported route.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen' || msg.type !== 'copy') return;
  const area = document.createElement('textarea');
  area.value = msg.text;
  document.body.append(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  sendResponse({ ok });
});
