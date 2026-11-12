import assert from 'node:assert/strict';
import fs from 'node:fs';
const moduleUrl = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const searchUrl = moduleUrl(fs.readFileSync(new URL('../src/search.js', import.meta.url), 'utf8'));
const sharedUrl = moduleUrl(fs.readFileSync(new URL('../src/shared.js', import.meta.url), 'utf8'));
const { rankSearch, destinationKey, searchMemoryText, normalizeSearchMemory } = await import(moduleUrl(fs.readFileSync(new URL('../src/search-ranking.js', import.meta.url), 'utf8').replaceAll('./search.js', searchUrl).replaceAll('./shared.js', sharedUrl)));
const now = Date.now();
const pin = { key: 'pin-1', kind: 'pin', label: 'GitHub', url: 'https://github.com/', spaceId: 'work' };
const ordinary = { key: 'tab-1', kind: 'tab', label: 'Ordinary tab', url: 'https://ordinary.example/', spaceId: 'work' };
const foreign = { key: 'pin-2', kind: 'pin', label: 'GitLab', url: 'https://gitlab.com/', spaceId: 'personal' };
const history = [{ id: 'h1', title: 'GitHub', url: 'https://github.com/', visitCount: 100, lastVisitTime: now },
  { id: 'h2', title: 'Azure DevOps', url: 'https://dev.azure.com/team', visitCount: 200, lastVisitTime: now }];
const rank = (query, extra = {}) => rankSearch({ items: [pin, ordinary, foreign], history, query, spaceId: 'work', now, ...extra });
assert.equal(rank('git')[0].key, 'pin-1');
assert.equal(rank('github.com')[0].key, 'pin-1');
assert.equal(rank('git')[1].badge, 'Search web');
assert.equal(rank('github.com')[1].kind, 'search');
assert.equal(rank('github.com')[1].text, 'github.com');
assert.equal(rank('git').filter(item => item.url === pin.url).length, 1);
assert.ok(!rank('').some(item => item.kind === 'tab' || item.key === foreign.key));
assert.ok(rank('git', { spaceId: 'personal' }).some(item => item.key === foreign.key));
assert.ok(!rank('git', { spaceId: 'personal' }).some(item => item.key === pin.key));
assert.equal(rank('', { items: [{ ...pin, spaceId: null }], history: [] })[0].key, pin.key);
assert.equal(rank('azure')[0].badge, 'History');
assert.equal(rank('team')[0].badge, 'History');
assert.equal(rank('how to configure git')[0].badge, 'Search web');
const searches = [{ text: 'how to configure git', count: 3, lastUsed: now }];
assert.equal(rank('', { items: [], history: [], memory: { searches } })[0].text, searches[0].text);
assert.equal(rank('how to configure git', { memory: { searches } }).filter(item => item.kind === 'search').length, 1);
const other = { key: 'other', kind: 'pin', label: 'GitLab', url: 'https://gitlab.com/', spaceId: 'work' };
assert.equal(rank('git', { items: [pin, other], history: [], memory: { selections: [{ query: 'git', key: 'https://gitlab.com', count: 15 }] } })[0].key, 'other');
assert.equal(rank('> archive', { items: [pin, { key: 'archive', kind: 'action', label: 'View archive' }] })[0].key, 'archive');
assert.equal(rank('https://example.com')[0].kind, 'navigate');
assert.equal(rank('https://example.com')[1].kind, 'search');
assert.equal(rank('unknown words')[0].badge, 'Search web');
const many = Array.from({ length: 15 }, (_, i) => ({ id: `many-${i}`, title: `Project ${i}`, url: `https://project.example/${i}`, visitCount: i, lastVisitTime: now }));
assert.ok(rank('project', { history: many }).length > 4);
assert.equal(rank('project', { history: many })[1].badge, 'Search web');
console.log('PASS ranking: current-space pins, Essentials, no ordinary tabs, fixed second-row search, history deduplication, local habits, recent searches, and scrollable result count');

const folderPins = [
  { ...pin, key: 'dashboard', label: 'Dashboard', url: 'https://app.example/#/dashboard' },
  { ...pin, key: 'reports', label: 'Reports', url: 'https://app.example/#/reports' },
];
assert.notEqual(destinationKey(folderPins[0].url), destinationKey(folderPins[1].url));
assert.equal(rank('Reports', { items: folderPins, history: [] })[0].key, 'reports');
const sharedUrlPins = [{ ...pin, key: 'essential', label: 'Company', spaceId: null }, { ...pin, key: 'work', label: 'Work tickets' }];
assert.equal(rank('Work tickets', { items: sharedUrlPins })[0].key, 'work');
assert.equal(rank('', { items: sharedUrlPins, history: [] }).filter(item => item.kind === 'pin').length, 2);
const renamed = { ...pin, label: 'Team board', url: 'https://app.example/doc/123' };
assert.equal(rank('Monthly planning', { items: [renamed], history: [{ id: 'alias', title: 'Monthly planning', url: renamed.url }] })[0].key, renamed.key);
const tokenUrl = 'https://user:password@app.example/callback?code=dummy-secret&view=inbox#access_token=dummy-token';
assert.equal(searchMemoryText(tokenUrl), 'https://app.example/callback?view=inbox');
const migrated = normalizeSearchMemory({ searches: [{ text: tokenUrl }], selections: [{ query: tokenUrl, key: tokenUrl }, { query: tokenUrl, key: 'search-' + tokenUrl }] });
assert.ok(!JSON.stringify(migrated).includes('dummy-'));
assert.ok(!JSON.stringify(migrated).includes('password'));
assert.ok(searchMemoryText('https://app.example/#/reports').endsWith('#/reports'));
console.log('PASS regressions: distinct folder pins, duplicate URLs, history-title aliases, and sanitizing new/existing search memory');

const { isDrifted } = await import(sharedUrl);
assert.equal(isDrifted({ url: 'https://app.example/#/dashboard', aliases: [] }, 'https://app.example/#/reports'), true);
assert.equal(isDrifted({ url: 'https://login.example/', aliases: ['https://app.example/#/dashboard'] }, 'https://app.example/#/dashboard'), false);
assert.equal(isDrifted({ url: 'https://login.example/', aliases: ['https://app.example/#/dashboard'] }, 'https://app.example/#/reports'), true);
for (const text of ['localhost', 'localhost:3000', 'example.com', 'Example.COM', 'https://Example.COM', 'git reset --soft HEAD~1']) {
  assert.equal(searchMemoryText(text), text);
  assert.equal(normalizeSearchMemory({ searches: [{ text }] }).searches[0].text, text);
}
assert.equal(searchMemoryText('example.com/callback?code=secret&view=inbox'), 'example.com/callback?view=inbox');
assert.equal(searchMemoryText('localhost:3000/callback?token=secret'), 'localhost:3000/callback');
console.log('PASS hash-route drift and redirect aliases; exact recent query text with URL-token redaction');
