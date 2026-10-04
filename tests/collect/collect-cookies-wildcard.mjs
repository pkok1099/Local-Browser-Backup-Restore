// Unit tests for the cookie wildcard (partitionKey:{}) with fallbacks.
//
// Covers:
//   1. wildcard happy path: one query returns plain + partitioned;
//   2. wildcard rejected (throws) -> legacy candidate scan;
//   3. wildcard silent under-return -> spot-check detects -> legacy scan;
//   4. no duplication between wildcard and legacy results;
//   5. non-default cookie stores excluded.
import assert from 'node:assert/strict';

let n = 0;
const check = (actual, expected, label) => {
  n++;
  assert.deepEqual(actual, expected, label);
};

const plainCookie = {
  name: 'plain',
  value: 'p1',
  domain: '127.0.0.1',
  path: '/',
  secure: false,
  httpOnly: false,
  sameSite: 'lax',
  hostOnly: true,
  session: false,
  storeId: '0',
};
const partitionedCookie = {
  name: 'chips',
  value: 'c1',
  domain: '127.0.0.1',
  path: '/',
  secure: true,
  httpOnly: false,
  sameSite: 'no_restriction',
  hostOnly: true,
  session: false,
  storeId: '0',
  partitionKey: { topLevelSite: 'http://127.0.0.1:9' },
};

function makeChrome({ wildcardBehavior = 'ok' } = {}) {
  const calls = [];
  const candidates = ['http://127.0.0.1:9/'];
  return {
    calls,
    chrome: {
      cookies: {
        getAllCookieStores: async () => [{ id: '0' }, { id: '1' }],
        getAll: async (q) => {
          calls.push(q);
          const hasWildcard =
            q.partitionKey && Object.keys(q.partitionKey).length === 0;
          if (hasWildcard) {
            if (wildcardBehavior === 'throw')
              throw new Error('invalid partitionKey');
            if (wildcardBehavior === 'silent') return [plainCookie];
            return [plainCookie, partitionedCookie];
          }
          if (q.partitionKey && q.partitionKey.topLevelSite)
            return [partitionedCookie];
          return [plainCookie];
        },
      },
      tabs: { query: async () => candidates.map((url) => ({ url })) },
      history: { search: async () => [] },
    },
  };
}

async function loadCollect(fake) {
  globalThis.chrome = fake.chrome;
  // Fresh import per scenario (module state is stateless here, but the
  // import cache would reuse the first chrome binding otherwise).
  const mod = await import(`../../src/lib/collect.js?scenario=${Math.random()}`);
  return mod;
}

// 1. Wildcard happy path: single query, both cookies, no per-candidate scan.
{
  const fake = makeChrome({ wildcardBehavior: 'ok' });
  const { collectCookies } = await loadCollect(fake);
  const out = await collectCookies();
  const names = out.cookies.map((c) => c.name).sort();
  check(names, ['chips', 'plain'], 'wildcard returns plain + partitioned');
  const chips = out.cookies.find((c) => c.name === 'chips');
  check(
    chips.partitionKey.topLevelSite,
    'http://127.0.0.1:9',
    'partitionKey preserved in serialization'
  );
  const perCandidate = fake.calls.filter(
    (q) => q.partitionKey && q.partitionKey.topLevelSite
  );
  check(perCandidate.length, 0, 'no per-candidate scan on happy path');
  check(
    fake.calls.filter(
      (q) => q.partitionKey && Object.keys(q.partitionKey).length === 0
    ).length,
    1,
    'exactly one wildcard query'
  );
}

// 2. Wildcard throws -> legacy candidate scan.
{
  const fake = makeChrome({ wildcardBehavior: 'throw' });
  const { collectCookies } = await loadCollect(fake);
  const out = await collectCookies();
  const names = out.cookies.map((c) => c.name).sort();
  check(names, ['chips', 'plain'], 'fallback finds both via legacy scan');
  const perCandidate = fake.calls.filter(
    (q) => q.partitionKey && q.partitionKey.topLevelSite
  );
  check(perCandidate.length >= 1, true, 'candidate scan ran on fallback');
  check(
    out.notes.some((x) => x.includes('falling back')),
    true,
    'fallback noted'
  );
}

// 3. Wildcard silent under-return -> spot-check -> legacy scan.
{
  const fake = makeChrome({ wildcardBehavior: 'silent' });
  const { collectCookies } = await loadCollect(fake);
  const out = await collectCookies();
  const names = out.cookies.map((c) => c.name).sort();
  check(
    names,
    ['chips', 'plain'],
    'silent under-return detected, legacy scan recovers partitioned'
  );
  check(
    out.notes.some((x) => x.includes('silently missed')),
    true,
    'silent fallback noted'
  );
}

// 4. Non-default store excluded.
{
  const fake = makeChrome({ wildcardBehavior: 'ok' });
  const { collectCookies } = await loadCollect(fake);
  const out = await collectCookies();
  check(
    out.notes.some((x) => x.includes('"1"')),
    true,
    'non-default store exclusion noted'
  );
  check(
    out.cookies.every((c) => c.storeId === '0'),
    true,
    'only default store cookies collected'
  );
}

console.log(`PASS collect-cookies-wildcard (${n} assertions)`);
