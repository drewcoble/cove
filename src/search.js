// Local search and URL recognition shared by the sidebar and New Tab page.
export function navigationUrl(value) {
  const text = value.trim();
  if (/^(https?:\/\/|file:\/\/|chrome:\/\/|about:)/i.test(text)) return text;
  if (/^localhost(:\d+)?([/?#].*)?$/i.test(text)) return 'http://' + text;
  if (!/\s/.test(text) && /^(?:\d{1,3}\.){3}\d{1,3}(:\d+)?([/?#].*)?$/.test(text)) return 'http://' + text;
  if (!/\s/.test(text) && /^([\w-]+\.)+[a-z]{2,}(:\d+)?([/?#].*)?$/i.test(text)) return 'https://' + text;
  return null;
}

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

export const isNewTabUrl = (url, extensionRoot) =>
  /^chrome:\/\/newtab\/?(?:[?#].*)?$/.test(url || '') ||
  (url || '').split(/[?#]/)[0] === extensionRoot + 'src/newtab.html';
