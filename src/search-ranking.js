import { navigationUrl, searchScore } from './search.js';
export { searchScore } from './search.js';

const normalized = value => (value || '').trim().toLocaleLowerCase();
export function destinationKey(url) {
  try { const u = new URL(url); u.hash = ''; return u.href.replace(/\/$/, ''); } catch { return url; }
}
const freshness = (time, now) => 20 / (1 + Math.max(0, now - (time || 0)) / 86400000 / 7);

// Intent wins over habit; habit breaks ties between similarly relevant destinations.
export function rankSearch({ items, history = [], memory = {}, query = '', spaceId, now = Date.now(), limit = 7 }) {
  const raw = query.trim();
  const commandsOnly = raw.startsWith('>');
  const q = normalized(commandsOnly ? raw.slice(1) : raw);
  const url = navigationUrl(raw);
  const question = /^(how|what|why|when|where|who|which|can|does|is|are|should)\b/.test(q) || q.split(/\s+/).length >= 4;
  const candidates = items.map(item => ({ ...item }));
  const destinations = new Map();
  for (const item of candidates) if (item.url) {
    item.destination = destinationKey(item.url);
    // Prefer the live tab over an unloaded pin or history copy of the same page.
    if (!destinations.has(item.destination) || (item.kind === 'tab' && destinations.get(item.destination).kind !== 'tab')) destinations.set(item.destination, item);
  }
  for (const entry of history) {
    const key = destinationKey(entry.url);
    const existing = destinations.get(key);
    if (existing) {
      existing.visitCount = (existing.visitCount || 0) + (entry.visitCount || 0);
      existing.lastVisitTime = Math.max(existing.lastVisitTime || 0, entry.lastVisitTime || 0);
      continue;
    }
    const item = { key: `history-${entry.id}`, kind: 'navigate', text: entry.url, url: entry.url, destination: key,
      label: entry.title || new URL(entry.url).hostname, detail: entry.url, searchDetail: entry.url,
      badge: 'History', visitCount: entry.visitCount, lastVisitTime: entry.lastVisitTime };
    destinations.set(key, item); candidates.push(item);
  }
  for (const entry of memory.searches || []) candidates.push({ key: `search-${normalized(entry.text)}`, kind: 'navigate', text: entry.text,
    label: entry.text, detail: 'Search again with your default search engine', badge: 'Recent search', count: entry.count, lastVisitTime: entry.lastUsed });
  const scored = [];
  for (const item of candidates) {
    const command = ['action', 'space'].includes(item.kind);
    if (commandsOnly && !command) continue;
    if (item.destination && destinations.get(item.destination) !== item) continue;
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
    if (item.kind === 'tab') score += 18 + Math.max(0, 12 - (item.mruRank ?? 12));
    if (item.spaceId === spaceId) score += 6;
    const selected = (memory.selections || []).find(entry => entry.query === q && entry.key === (item.destination || item.key));
    if (q && selected) score += Math.min(55, 15 + Math.log2(1 + selected.count) * 12);
    scored.push({ item, score });
  }
  if (q && !commandsOnly) {
    const duplicate = url && scored.find(({ item }) => item.destination === destinationKey(url));
    const repeated = !url && scored.find(({ item }) => item.badge === 'Recent search' && normalized(item.text) === q);
    if (!duplicate && !repeated) scored.push({ score: url ? 240 : question ? 230 : 95,
      item: { key: 'navigate', kind: 'navigate', text: raw, label: url ? `Go to ${raw}` : `Search for “${raw}”`,
        detail: 'Open in a new tab in this space', badge: url ? 'Visit' : 'Search web' } });
  }
  return scored.sort((a, b) => b.score - a.score || a.item.key.localeCompare(b.item.key)).slice(0, limit).map(entry => entry.item);
}
