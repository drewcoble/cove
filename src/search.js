// URL recognition and match scoring shared by every search surface (the launcher and the
// sidebar URL bar). Adapted from a contribution by Julio Orozco (drewcoble/cove#1).

// Text the user typed -> a URL to open, or null when it should be a web search.
export function navigationUrl(value) {
  const text = value.trim();
  if (/^(https?:\/\/|file:\/\/|chrome:\/\/|about:)/i.test(text)) return text;
  if (/\s/.test(text)) return null;
  if (/^localhost(:\d+)?([/?#].*)?$/i.test(text)) return 'http://' + text;
  if (/^(?:\d{1,3}\.){3}\d{1,3}(:\d+)?([/?#].*)?$/.test(text)) return 'http://' + text;
  if (/^([\w-]+\.)+[a-z]{2,}(:\d+)?([/?#].*)?$/i.test(text)) return 'https://' + text;
  return null;
}

// Higher is better; -1 means "doesn't match". Every word must hit the title, the detail, or
// (as a last resort) be a subsequence of the title.
export function searchScore(label, detail, query) {
  const title = label.toLocaleLowerCase();
  const haystack = `${title} ${detail || ''}`.toLocaleLowerCase();
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  let score = 0;
  for (const word of words) {
    if (title === word) score += 120;
    else if (title.startsWith(word)) score += 90;
    else if (title.includes(word)) score += 65;
    else if (haystack.includes(word)) score += 35;
    else {
      let i = 0;
      for (const char of title) if (char === word[i]) i++;
      if (i !== word.length) return -1;
      score += 10;
    }
  }
  return score;
}

// Pages that are Cove's own UI or an empty New Tab, which search never lists as results. The
// launcher may be at the extension id or its per-session dynamic id (use_dynamic_url).
export const isLauncherOrNewTab = (url, extensionRoot) =>
  /^chrome:\/\/(newtab|new-tab-page)\/?(?:[?#].*)?$/.test(url || '') ||
  (url || '').startsWith(extensionRoot) ||
  /^chrome-extension:\/\/[^/]+\/src\/launcher\.html/.test(url || '');
