// GitHub picker support (LIB): listRepositories / listBranches with RFC 5988
// pagination, strict token hygiene, and a relaxed constructor (owner/repo
// optional — repository-scoped calls fail with ERR_NOT_CONFIGURED instead).
import assert from 'node:assert/strict';
import { GitHubStorageProvider } from '../../src/lib/github.js';
import {
  tokenChangedTransition,
  branchPickerMode,
  isEmptyRepoList,
} from '../../src/lib/cloud-picker.js';

const TOKEN = 'ghp_picker_test_token_ABCDEF123456';
const savedFetch = globalThis.fetch;

function mockResponse({ status = 200, json = null, link = null }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (json === null ? '' : JSON.stringify(json)),
    json: async () => {
      if (json === null) throw new SyntaxError('Unexpected end of JSON input');
      return json;
    },
    headers: {
      get: (name) => (String(name).toLowerCase() === 'link' ? link : null),
    },
  };
}

function setFetch(handler) {
  globalThis.fetch = handler;
}

try {
  // ---- listRepositories: 2-page pagination via Link rel="next" ----
  {
    const page1 = [
      {
        id: 1,
        name: 'alpha',
        full_name: 'octo/alpha',
        private: false,
        default_branch: 'main',
        updated_at: '2026-09-01T10:00:00Z',
        owner: { login: 'octo' },
      },
      {
        id: 2,
        name: 'beta',
        full_name: 'octo/beta',
        private: true,
        default_branch: 'trunk',
        updated_at: '2026-09-02T10:00:00Z',
        owner: { login: 'octo' },
      },
    ];
    const page2 = [
      {
        id: 3,
        name: 'gamma',
        full_name: 'octo/gamma',
        private: false,
        default_branch: null,
        updated_at: null,
        owner: { login: 'octo' },
      },
      { name: 'broken-entry' }, // incomplete: no owner/full_name -> filtered
    ];
    const urls = [];
    setFetch(async (url, opts) => {
      urls.push(String(url));
      assert.equal(
        opts.headers.Authorization,
        `Bearer ${TOKEN}`,
        'token travels only in the Authorization header'
      );
      if (urls.length === 1) {
        return mockResponse({
          json: page1,
          link: '<https://api.github.com/user/repos?page=2&per_page=100>; rel="next", <https://api.github.com/user/repos?page=2&per_page=100>; rel="last"',
        });
      }
      return mockResponse({ json: page2 });
    });
    const p = new GitHubStorageProvider({ token: TOKEN });
    const repos = await p.listRepositories();
    assert.equal(urls.length, 2, 'must follow rel="next" exactly once');
    assert.ok(urls[0].includes('/user/repos?'), 'first request hits /user/repos');
    assert.ok(urls[0].includes('per_page=100'), 'requests 100 repos per page');
    assert.ok(urls[0].includes('sort=updated'), 'sorts by updated');
    assert.ok(urls[0].includes('direction=desc'), 'sorts descending');
    assert.equal(
      urls[1],
      'https://api.github.com/user/repos?page=2&per_page=100',
      'follows the next URL verbatim'
    );
    assert.equal(repos.length, 3, 'pages merged, incomplete entry filtered');
    assert.deepEqual(repos[0], {
      owner: 'octo',
      name: 'alpha',
      fullName: 'octo/alpha',
      private: false,
      defaultBranch: 'main',
      updatedAt: '2026-09-01T10:00:00Z',
    });
    assert.deepEqual(repos[1], {
      owner: 'octo',
      name: 'beta',
      fullName: 'octo/beta',
      private: true,
      defaultBranch: 'trunk',
      updatedAt: '2026-09-02T10:00:00Z',
    });
    assert.deepEqual(repos[2], {
      owner: 'octo',
      name: 'gamma',
      fullName: 'octo/gamma',
      private: false,
      defaultBranch: 'main',
      updatedAt: null,
    });
    assert.ok(
      !JSON.stringify(repos).includes(TOKEN),
      'token must not appear in the return value'
    );
    console.log('PASS listRepositories merges two pages via Link rel=next');
  }

  // ---- listRepositories: 401 -> ERR_GITHUB_AUTH, token-free message ----
  {
    setFetch(async (url, opts) => {
      assert.equal(opts.headers.Authorization, `Bearer ${TOKEN}`);
      return mockResponse({ status: 401, json: { message: 'Bad credentials' } });
    });
    const p = new GitHubStorageProvider({ token: TOKEN });
    let code = null;
    let message = '';
    try {
      await p.listRepositories();
    } catch (e) {
      code = e.code;
      message = e.message;
    }
    assert.equal(code, 'ERR_GITHUB_AUTH', '401 maps to ERR_GITHUB_AUTH');
    assert.ok(
      !message.includes(TOKEN),
      'auth error message must not contain the token'
    );
    console.log('PASS listRepositories 401 -> ERR_GITHUB_AUTH, no token leak');
  }

  // ---- listBranches: single page ----
  {
    const urls = [];
    setFetch(async (url, opts) => {
      urls.push(String(url));
      assert.equal(opts.headers.Authorization, `Bearer ${TOKEN}`);
      return mockResponse({ json: [{ name: 'main' }, { name: 'dev' }] });
    });
    const p = new GitHubStorageProvider({
      token: TOKEN,
      owner: 'octo',
      repo: 'vault',
    });
    const branches = await p.listBranches();
    assert.deepEqual(branches, ['main', 'dev']);
    assert.ok(
      urls[0].includes('/repos/octo/vault/branches?'),
      'hits the branches endpoint'
    );
    assert.ok(urls[0].includes('per_page=100'), 'requests 100 branches');
    assert.ok(
      !JSON.stringify(branches).includes(TOKEN),
      'token must not appear in the return value'
    );
    console.log('PASS listBranches returns branch names');
  }

  // ---- listBranches: paginated ----
  {
    const urls = [];
    setFetch(async (url) => {
      urls.push(String(url));
      if (urls.length === 1) {
        return mockResponse({
          json: [{ name: 'main' }],
          link: '<https://api.github.com/repos/octo/vault/branches?per_page=100&page=2>; rel="next"',
        });
      }
      return mockResponse({ json: [{ name: 'dev' }] });
    });
    const p = new GitHubStorageProvider({
      token: TOKEN,
      owner: 'octo',
      repo: 'vault',
    });
    assert.deepEqual(await p.listBranches(), ['main', 'dev']);
    assert.equal(urls.length, 2, 'follows rel="next"');
    console.log('PASS listBranches follows pagination');
  }

  // ---- listBranches without owner/repo -> ERR_NOT_CONFIGURED, no fetch ----
  {
    let fetchCalls = 0;
    setFetch(async () => {
      fetchCalls++;
      throw new Error('fetch must not be called without owner/repo');
    });
    const p = new GitHubStorageProvider({ token: TOKEN });
    let code = null;
    try {
      await p.listBranches();
    } catch (e) {
      code = e.code;
    }
    assert.equal(code, 'ERR_NOT_CONFIGURED');
    assert.equal(fetchCalls, 0, 'no HTTP request before repo is configured');
    console.log('PASS listBranches without owner/repo -> ERR_NOT_CONFIGURED');
  }

  // ---- constructor: token required, owner/repo optional ----
  {
    assert.throws(
      () => new GitHubStorageProvider(),
      (e) => e.code === 'ERR_NOT_CONFIGURED',
      'missing cfg still throws'
    );
    assert.throws(
      () => new GitHubStorageProvider({ token: '' }),
      (e) => e.code === 'ERR_NOT_CONFIGURED',
      'empty token still throws'
    );
    const p = new GitHubStorageProvider({ token: TOKEN });
    assert.equal(p.owner, null, 'owner defaults to null');
    assert.equal(p.repo, null, 'repo defaults to null');
    let fetchCalls = 0;
    setFetch(async () => {
      fetchCalls++;
      return mockResponse({ json: {} });
    });
    let code = null;
    try {
      await p.connect();
    } catch (e) {
      code = e.code;
    }
    assert.equal(code, 'ERR_NOT_CONFIGURED', 'connect() requires owner/repo');
    assert.equal(fetchCalls, 0, 'connect must not hit the network unconfigured');
    console.log('PASS constructor: token required, owner/repo optional');
  }

  // ---- foreign-origin pagination URL is rejected, never fetched ----
  {
    const urls = [];
    setFetch(async (url) => {
      urls.push(String(url));
      if (urls.length === 1) {
        return mockResponse({
          json: [
            {
              name: 'x',
              full_name: 'octo/x',
              private: false,
              owner: { login: 'octo' },
            },
          ],
          link: '<https://evil.example/next>; rel="next"',
        });
      }
      throw new Error('must never fetch a foreign origin');
    });
    const p = new GitHubStorageProvider({ token: TOKEN });
    let code = null;
    let message = '';
    try {
      await p.listRepositories();
    } catch (e) {
      code = e.code;
      message = e.message;
    }
    assert.equal(code, 'ERR_GITHUB_HTTP');
    assert.equal(urls.length, 1, 'foreign next URL must not be fetched');
    assert.ok(
      !message.includes(TOKEN),
      'rejection message must not contain the token'
    );
    assert.ok(
      !message.includes('evil.example'),
      'rejection message must not name the foreign host'
    );
    console.log('PASS foreign-origin pagination URL rejected safely');
  }
} finally {
  globalThis.fetch = savedFetch;
}


// ---- cloud-picker pure UI-state helpers (4 gaps) ----
{
  // Gap 1: token change must clear every repo/branch selection so stale
  // values from the old token can never be submitted unvalidated.
  const t = tokenChangedTransition();
  assert.deepEqual(t.form, { owner: '', repo: '', branch: '' });
  assert.deepEqual(t.cloud, {
    repoList: null,
    branchList: null,
    tokenValid: null,
    repoInfo: null,
    repoInfoError: null,
  });
  for (const k of ['owner', 'repo', 'branch'])
    assert.ok(k in t.form, `form.${k} must be reset`);
  for (const k of ['repoList', 'branchList', 'tokenValid'])
    assert.ok(k in t.cloud, `cloud.${k} must be reset`);
  console.log('PASS tokenChangedTransition clears repo/branch state');
}
{
  // Gap 2: branch picker has three visually distinct states (not one).
  const B = (branchList, repoSelected, repoManual = false) =>
    branchPickerMode({ branchList, repoSelected, repoManual });
  assert.equal(B(null, false), 'choose-repo-first');
  assert.equal(B(null, true), 'loading');
  assert.equal(
    B({ loading: true, error: null, branches: [], manual: false }, true),
    'loading'
  );
  assert.equal(
    B({ loading: false, error: null, branches: ['main'], manual: false }, true),
    'ready'
  );
  assert.equal(
    B({ loading: false, error: 'boom', branches: [], manual: false }, true),
    'manual',
    'fetch failure falls back to manual entry, never stuck disabled'
  );
  assert.equal(
    B({ loading: false, error: null, branches: [], manual: true }, true),
    'manual'
  );
  assert.equal(B(null, true, true), 'manual', 'manual repo -> manual branch');
  console.log('PASS branchPickerMode distinguishes 3 states + manual');
}
{
  // Gap 4: empty list on a valid token signals a fine-grained PAT.
  assert.equal(isEmptyRepoList([]), true);
  assert.equal(isEmptyRepoList([{ fullName: 'a/b' }]), false);
  assert.equal(isEmptyRepoList(null), false);
  console.log('PASS isEmptyRepoList');
}

console.log('PASS github picker (listRepositories/listBranches)');
{
  // validateToken: lightweight GET /user, no owner/repo required.
  setFetch(async (url, opts) => {
    assert.equal(new URL(url).pathname, '/user');
    assert.equal(opts.headers.Authorization, 'Bearer t');
    return mockResponse({ status: 200, json: { login: 'octo' } });
  });
  const p = new GitHubStorageProvider({ token: 't' });
  const acct = await p.validateToken();
  assert.equal(acct.login, 'octo');
  console.log('PASS validateToken returns login');
}
{
  // validateToken: 401 -> ERR_GITHUB_AUTH, token not in message.
  setFetch(async () => mockResponse({ status: 401, json: { message: 'Bad' } }));
  const p = new GitHubStorageProvider({ token: 'secret-xyz' });
  await assert.rejects(() => p.validateToken(), (e) => {
    assert.equal(e.code, 'ERR_GITHUB_AUTH');
    assert.ok(!String(e.message).includes('secret-xyz'));
    return true;
  });
  console.log('PASS validateToken 401 without token leak');
}
{
  // filterRepos: client-side substring filter, case-insensitive.
  const { filterRepos } = await import('../../src/lib/cloud-picker.js');
  const repos = [
    { fullName: 'octo/Alpha' },
    { fullName: 'octo/beta' },
    { fullName: 'other/gamma-alpha' },
  ];
  assert.deepEqual(filterRepos(repos, ''), repos);
  assert.deepEqual(filterRepos(repos, 'alpha').map((r) => r.fullName), [
    'octo/Alpha',
    'other/gamma-alpha',
  ]);
  assert.deepEqual(filterRepos(repos, 'BETA').map((r) => r.fullName), [
    'octo/beta',
  ]);
  assert.deepEqual(filterRepos(repos, 'zzz'), []);
  assert.deepEqual(filterRepos(null, 'a'), []);
  console.log('PASS filterRepos');
}
