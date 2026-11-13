import { navigationUrl, searchScore } from './search.js';
import { redactUrl } from './shared.js';
export { searchScore } from './search.js';

const normalized = value => (value || '').trim().toLocaleLowerCase();
export function destinationKey(url) {
  try { const u = new URL(url); return /^https?:$/.test(u.protocol) && u.pathname === '/' && !u.search && !u.hash ? u.origin : u.href; } catch { return url; }
}
// Sanitize URL-shaped input before it becomes local ranking/search memory.
export function searchMemoryText(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  const url = navigationUrl(text);
  if (!url) return text.slice(0, 500);
  try {
    const original = new URL(url).href;
    const clean = redactUrl(url, { keepHash: true });
    if (!clean) return '';
    const parsed = new URL(clean); parsed.username = ''; parsed.password = '';
    // Preserve the submitted spelling and URL-vs-search intent unless redaction is needed.
    if (parsed.href === original) return text.slice(0, 500);
    const explicitScheme = /^(https?:\/\/|file:\/\/|chrome:\/\/|about:)/i.test(text);
    return (explicitScheme ? parsed.href : parsed.href.replace(/^https?:\/\//, '')).slice(0, 500);
  } catch { return ''; }
}

export function normalizeSearchMemory(memory = {}) {
  return {
    searches: (Array.isArray(memory.searches) ? memory.searches : []).map(entry => ({
      text: searchMemoryText(entry.text), count: entry.count || 1, lastUsed: entry.lastUsed || 0,
    })).filter(entry => entry.text).slice(0, 50),
    selections: (Array.isArray(memory.selections) ? memory.selections : []).map(entry => ({
      query: normalized(searchMemoryText(entry.query)),
      key: entry.key?.startsWith('search-') ? `search-${normalized(searchMemoryText(entry.key.slice(7)))}`
        : navigationUrl(entry.key || '') ? destinationKey(searchMemoryText(entry.key)) : entry.key,
      count: entry.count || 1, lastUsed: entry.lastUsed || 0,
    })).filter(entry => entry.query && entry.key).slice(0, 100),
  };
}

const freshness = (time, now) => 20 / (1 + Math.max(0, now - (time || 0)) / 86400000 / 7);

// Rank local destinations by relevance and habit, reserving the second row for web search.
export function rankSearch({ items, history = [], memory = {}, query = '', spaceId, now = Date.now(), limit = 50 }) {
  const raw = query.trim();
  const commandsOnly = raw.startsWith('>');
  const q = normalized(commandsOnly ? raw.slice(1) : raw);
  const memoryQuery = normalized(searchMemoryText(raw));
  const url = navigationUrl(raw);
  const question = /^(how|what|why|when|where|who|which|can|does|is|are|should)\b/.test(q) || q.split(/\s+/).length >= 4;
  const candidates = items.filter(item => commandsOnly
    ? ['action', 'space'].includes(item.kind)
    : item.kind === 'pin' && (item.spaceId == null || item.spaceId === spaceId)).map(item => ({ ...item }));
  const destinations = new Map();
  for (const item of candidates) if (item.url) {
    item.destination = destinationKey(item.url);
    const peers = destinations.get(item.destination) || [];
    peers.push(item); destinations.set(item.destination, peers);
  }
  for (const entry of history) {
    const key = destinationKey(entry.url);
    const existing = destinations.get(key);
    if (existing) {
      for (const item of existing) {
        item.visitCount = (item.visitCount || 0) + (entry.visitCount || 0);
        item.lastVisitTime = Math.max(item.lastVisitTime || 0, entry.lastVisitTime || 0);
        item.searchDetail = `${item.searchDetail || ''} ${entry.title || ''}`;
      }
      continue;
    }
    const item = { key: `history-${entry.id}`, kind: 'navigate', text: entry.url, url: entry.url, destination: key,
      label: entry.title || new URL(entry.url).hostname, detail: entry.url, searchDetail: entry.url,
      badge: 'History', visitCount: entry.visitCount, lastVisitTime: entry.lastVisitTime };
    destinations.set(key, [item]); candidates.push(item);
  }
  for (const entry of memory.searches || []) candidates.push({ key: `search-${normalized(entry.text)}`, kind: 'search', text: entry.text,
    label: entry.text, detail: 'Search again with your default search engine', badge: 'Recent search', count: entry.count, lastVisitTime: entry.lastUsed });
  const scored = [];
  for (const item of candidates) {
    const command = ['action', 'space'].includes(item.kind);
    if (commandsOnly && !command) continue;
    const match = searchScore(item.label, `${item.url || ''} ${item.searchDetail || ''} ${item.detail || ''}`, q);
    if (match < 0) continue;
    let score = q ? Math.min(match, 180) : 0;
    if (q && normalized(item.label) === q) score += 110;
    if (q && item.url) {
      const host = new URL(item.url).hostname.replace(/^www\./, '');
      if (url && destinationKey(url) === item.destination) score += 220;
      else if (host === q || host.startsWith(q)) score += 100;
      else if (!/\s/.test(q) && new URL(item.url).pathname.toLocaleLowerCase().includes(q)) score += 65;
    }
    if (!commandsOnly && command) score -= q ? 25 : 90;
    if (question && item.badge !== 'Recent search') score -= 90;
    score += Math.min(30, Math.log2(1 + (item.visitCount || item.count || 0)) * 6);
    score += freshness(item.lastVisitTime || item.lastAccessed, now);
    if (item.spaceId === spaceId) score += 6;
    const selected = (memory.selections || []).find(entry => entry.query === memoryQuery && (entry.key === (item.kind === 'pin' ? item.key : item.destination || item.key) || item.kind === 'pin' && entry.key === item.destination));
    if (q && selected) score += Math.min(55, 15 + Math.log2(1 + selected.count) * 12);
    scored.push({ item, score });
  }
  if (q && !commandsOnly && url && !scored.some(({ item }) => item.destination === destinationKey(url))) {
    scored.push({ score: 240, item: { key: 'navigate', kind: 'navigate', text: raw, url,
      label: `Go to ${raw}`, detail: 'Open in a new tab in this space', badge: 'Visit' } });
  }
  const results = scored.sort((a, b) => b.score - a.score || a.item.key.localeCompare(b.item.key)).map(entry => entry.item);
  if (q && !commandsOnly) {
    // The explicit search action also covers exact repeated searches; avoid two identical rows.
    const distinct = results.filter(item => item.kind !== 'search' || normalized(item.text) !== q);
    distinct.splice(Math.min(1, distinct.length), 0, { key: 'search-web', kind: 'search', text: raw,
      label: `Search for “${raw}”`, detail: 'Use your default search engine', badge: 'Search web' });
    return distinct.slice(0, limit);
  }
  return results.slice(0, limit);
}
