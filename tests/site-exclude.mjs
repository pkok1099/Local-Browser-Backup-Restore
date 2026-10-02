import assert from 'node:assert/strict';
const { isExcluded, SITE_DATA_CONFIG } = await import('../src/lib/sitedata.js');

// Hostname-based matching (not substring)
const cases = [
  ['http://localhost/', true],
  ['http://localhost:3000/', true],
  ['https://localhost/', true],
  ['http://app.localhost/', true],
  ['http://foo.bar.localhost:8080/x', true],
  ['http://127.0.0.1/', true],
  ['http://127.0.0.1:8080/', true],
  ['http://192.168.1.1/', true],
  ['http://192.168.1.1:3000/path', true],
  ['https://192.0.2.1/', true],
  ['https://chromewebstore.google.com/', true],
  ['https://chromewebstore.google.com/detail/x', true],
  ['chrome://settings/', true],
  ['chrome-extension://abc/', true],
  ['file:///etc/passwd', true],
  ['about:blank', true],
  ['data:text/html,hi', true],
  ['javascript:alert(1)', true],
  // NOT excluded:
  ['https://example.com/', false],
  ['https://contoh.com/?q=localhost', false], // substring in query must NOT block
  ['https://localhost.example.com/', false], // localhost as subdomain of public domain
  ['https://192.example.com/', false], // starts with 192. but not an IP
  ['http://example.com:8080/', false],
];
for (const [url, expected] of cases) {
  const { excluded, reason } = isExcluded(url);
  assert.equal(excluded, expected, `${url} should ${expected ? 'be' : 'NOT be'} excluded (reason: ${reason})`);
}
console.log(`PASS isExcluded: ${cases.length} cases (hostname-based, no substring false-positives)`);

// Config is extensible
assert.ok(Array.isArray(SITE_DATA_CONFIG.excluded.hosts));
assert.ok(Array.isArray(SITE_DATA_CONFIG.excluded.schemes));
console.log('PASS isExcluded config is extensible');
