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

const hostOf = url => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};
const pathOf = url => {
  try {
    return new URL(url).pathname.toLocaleLowerCase();
  } catch {
    return '';
  }
};
const freshness = (time, now) => 20 / (1 + Math.max(0, now - (time || 0)) / 86400000 / 7);

export function rankSearch({ items, history = [], memory = {}, query = '', spaceId, now = Date.now(), limit = 7 }) {
  const raw = query.trim();
  const commandsOnly = raw.startsWith('>');
  const q = normalized(commandsOnly ? raw.slice(1) : raw);
  const memoryQuery = normalized(searchMemoryText(raw));
  const url = navigationUrl(raw);
  const question = /^(how|what|why|when|where|who|which|can|does|is|are|should)\b/.test(q) || q.split(/\s+/).length >= 4;
  const candidates = items.map(item => ({ ...item }));
  const destinations = new Map();
  for (const item of candidates) {
    if (!item.url) continue;
    item.destination = destinationKey(item.url);
    item.host = hostOf(item.url);
    // Prefer the live tab over an unloaded pin or a history entry for the same page.
    const existing = destinations.get(item.destination);
    if (!existing || (item.kind === 'tab' && existing.kind !== 'tab')) destinations.set(item.destination, item);
  }
  for (const entry of history) {
    const key = destinationKey(entry.url);
    const existing = destinations.get(key);
    if (existing) {
      existing.visitCount = (existing.visitCount || 0) + (entry.visitCount || 0);
      existing.lastVisitTime = Math.max(existing.lastVisitTime || 0, entry.lastVisitTime || 0);
      continue;
    }
    const item = {
      key: `history-${entry.id}`, kind: 'navigate', text: entry.url, url: entry.url, destination: key, host: hostOf(entry.url),
      label: entry.title || hostOf(entry.url) || entry.url, detail: entry.url, searchDetail: entry.url,
      badge: 'History', visitCount: entry.visitCount, lastVisitTime: entry.lastVisitTime,
    };
    destinations.set(key, item);
    candidates.push(item);
  }
  for (const entry of memory.searches || []) {
    candidates.push({
      key: `search-${normalized(entry.text)}`, kind: 'search', text: entry.text, label: entry.text,
      detail: 'Search again with your default search engine', badge: 'Recent search', icon: 'search',
      count: entry.count, lastVisitTime: entry.lastUsed,
    });
  }
  const selections = new Map((memory.selections || []).filter(s => s.query === memoryQuery).map(s => [s.key, s.count]));
  const scored = [];
  for (const item of candidates) {
    const command = item.kind === 'action' || item.kind === 'space';
    if (commandsOnly && !command) continue;
    if (item.destination && destinations.get(item.destination) !== item) continue;
    const match = searchScore(item.label, `${item.url || ''} ${item.searchDetail || ''} ${item.detail || ''}`, q);
    if (match < 0) continue;
    let score = q ? Math.min(match, 180) : 0;
    if (q && normalized(item.label) === q) score += 110;
    if (q && item.url) {
      if (url && destinationKey(url) === item.destination) score += 220;
      else if (item.host === q || item.host.startsWith(q)) score += 100;
      else if (!/\s/.test(q) && pathOf(item.url).includes(q)) score += 65;
    }
    if (!commandsOnly && command) score -= q ? 25 : 90;
    if (question && item.badge !== 'Recent search') score -= 90;
    score += Math.min(30, Math.log2(1 + (item.visitCount || item.count || 0)) * 6);
    score += freshness(item.lastVisitTime || item.lastAccessed, now);
    if (item.kind === 'tab') score += 18 + Math.max(0, 12 - (item.mruRank ?? 12));
    if (item.spaceId === spaceId) score += 6;
    const chosen = q && selections.get(item.destination || item.key);
    if (chosen) score += Math.min(55, 15 + Math.log2(1 + chosen) * 12);
    scored.push({ item, score });
  }
  if (q && !commandsOnly) {
    const duplicate = url && scored.find(({ item }) => item.destination === destinationKey(url));
    const repeated = !url && scored.find(({ item }) => item.badge === 'Recent search' && normalized(item.text) === q);
    if (!duplicate && !repeated) {
      scored.push({
        score: url ? 240 : question ? 230 : 95,
        item: { key: 'navigate', kind: url ? 'navigate' : 'search', text: raw, label: url ? `Go to ${raw}` : `Search for “${raw}”`,
          detail: 'Open in a new tab in this space', badge: url ? 'Visit' : 'Search web', icon: url ? 'globe' : 'search' },
      });
    }
  }
  const ranked = scored.sort((a, b) => b.score - a.score || a.item.key.localeCompare(b.item.key));
  // Always keep a way to search the web for exactly what was typed within the first two rows.
  // Multi-word queries that match many visited pages would otherwise push it out of view.
  if (q && !commandsOnly && !url) {
    const web = ranked.findIndex(({ item }) => item.key === 'navigate' || (item.badge === 'Recent search' && normalized(item.text) === q));
    if (web > 1) ranked.splice(1, 0, ...ranked.splice(web, 1));
  }
  return ranked.slice(0, limit).map(entry => entry.item);
}
