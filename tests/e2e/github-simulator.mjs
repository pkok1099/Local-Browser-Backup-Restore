// Minimal in-memory GitHub REST API simulator for the extension's E2E suite.
//
// Implements exactly the surface GitHubStorageProvider uses (see
// src/lib/github.js):
//   GET  /user
//   GET  /repos/{owner}/{repo}
//   GET  /repos/{owner}/{repo}/contents/{path}?ref=...   (raw body OR {sha} JSON)
//   PUT  /repos/{owner}/{repo}/contents/{path}           {message, content(b64), branch, sha?}
//   DELETE /repos/{owner}/{repo}/contents/{path}         {message, sha, branch}
//   GET  /repos/{owner}/{repo}/contents/{dir}?ref=...    (JSON array for directory listing)
//
// Every request is recorded in `sim.audit` (method, path, headers, body) so
// tests can assert secret hygiene: the token must appear ONLY in the
// Authorization header, never in URLs, bodies or error messages; the backup
// password must never appear anywhere.
//
// Fault injection: sim.failNext(n, { status, methods }) makes the next n
// matching requests fail with the given HTTP status (default 500 on PUT/DELETE),
// exercising the extension's typed-error + pending-upload retry path.
//
// Tampering: sim.tamper(path, fn) rewrites stored bytes, exercising the
// remote-verification / manifest-digest integrity checks.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

// git blob sha1 = sha1("blob <len>\0" + content) — must match the provider's
// verification exactly (see gitBlobSha1 in src/lib/github.js).
export function gitBlobSha1(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const header = Buffer.from(`blob ${buf.length}\0`, 'utf8');
  return createHash('sha1').update(Buffer.concat([header, buf])).digest('hex');
}

export function createGitHubSimulator({ owner = 'e2e', repo = 'vault', isPublic = false, defaultBranch = 'main' } = {}) {
  const files = new Map(); // relPath -> Buffer
  const audit = [];
  let publicRepo = !!isPublic;
  let failPlan = []; // [{ remaining, status, methods:Set }]

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks);
      let body = null;
      const ctype = req.headers['content-type'] || '';
      if (rawBody.length && ctype.includes('json')) {
        try { body = JSON.parse(rawBody.toString('utf8')); } catch { body = null; }
      }
      const url = new URL(req.url, 'http://127.0.0.1');
      const entry = {
        method: req.method,
        path: url.pathname,
        query: url.search,
        authorization: req.headers['authorization'] || null,
        bodyText: rawBody.length ? rawBody.toString('utf8') : '',
        bodyJson: body,
        status: null
      };
      audit.push(entry);

      const send = (status, payload, contentType = 'application/json') => {
        entry.status = status;
        const out = typeof payload === 'string' ? payload : JSON.stringify(payload);
        res.writeHead(status, {
          'Content-Type': contentType,
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS'
        });
        res.end(out);
      };

      if (req.method === 'OPTIONS') {
        entry.status = 204;
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS'
        });
        res.end();
        return;
      }

      // Fault injection (checked before routing so it can hit any endpoint).
      for (const plan of failPlan) {
        if (plan.remaining > 0 && plan.methods.has(req.method)) {
          plan.remaining -= 1;
          return send(plan.status, { message: `simulated failure (${plan.status})` });
        }
      }

      const p = url.pathname;
      if (p === '/user' && req.method === 'GET') {
        return send(200, { login: 'e2e-bot', id: 4242, type: 'User' });
      }

      const repoPrefix = `/repos/${owner}/${repo}`;
      if (p === repoPrefix && req.method === 'GET') {
        return send(200, {
          full_name: `${owner}/${repo}`,
          private: !publicRepo,
          default_branch: defaultBranch,
          permissions: { admin: true, push: true, pull: true },
          visibility: publicRepo ? 'public' : 'private'
        });
      }

      const contentsPrefix = `${repoPrefix}/contents/`;
      if (!p.startsWith(contentsPrefix)) {
        return send(404, { message: 'Not Found' });
      }
      const rel = decodeURIComponent(p.slice(contentsPrefix.length));
      const accept = req.headers['accept'] || '';
      const wantRaw = accept.includes('vnd.github.raw');

      if (req.method === 'GET') {
        // Directory listing fallback (used by listBackups when the manifest is missing).
        const children = [...files.keys()].filter((k) => k.startsWith(rel + '/'));
        if (children.length > 0) {
          const listing = children.map((k) => {
            const buf = files.get(k);
            return { type: 'file', name: k.split('/').pop(), path: k, sha: gitBlobSha1(buf), size: buf.length };
          });
          return send(200, listing);
        }
        const buf = files.get(rel);
        if (!buf) return send(404, { message: 'Not Found' });
        if (wantRaw) return send(200, buf.toString('utf8'), 'text/plain; charset=utf-8');
        return send(200, { type: 'file', name: rel.split('/').pop(), path: rel, sha: gitBlobSha1(buf), size: buf.length });
      }

      if (req.method === 'PUT') {
        if (!body || typeof body.content !== 'string') return send(422, { message: 'content is required' });
        const buf = Buffer.from(body.content, 'base64');
        const current = files.get(rel);
        if (current && body.sha && body.sha !== gitBlobSha1(current)) {
          return send(422, { message: 'sha mismatch: file changed since you last fetched it' });
        }
        files.set(rel, buf);
        const sha = gitBlobSha1(buf);
        return send(current ? 200 : 201, { content: { name: rel.split('/').pop(), path: rel, sha } });
      }

      if (req.method === 'DELETE') {
        const current = files.get(rel);
        if (!current) return send(404, { message: 'Not Found' });
        if (body && body.sha && body.sha !== gitBlobSha1(current)) {
          return send(422, { message: 'sha mismatch: file changed since you last fetched it' });
        }
        files.delete(rel);
        return send(200, { content: null, commit: { sha: 'deadbee'.repeat(5).slice(0, 40) } });
      }

      return send(405, { message: 'Method Not Allowed' });
    });
  });

  const sim = {
    audit,
    start: () => new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        sim.url = `http://127.0.0.1:${server.address().port}`;
        resolve(sim.url);
      });
    }),
    stop: () => new Promise((resolve) => server.close(resolve)),
    url: null,
    setPublic: (v) => { publicRepo = !!v; },
    isPublic: () => publicRepo,
    // Next n requests with a matching method fail with `status`.
    failNext: (n, { status = 500, methods = ['PUT', 'DELETE'] } = {}) => {
      failPlan.push({ remaining: n, status, methods: new Set(methods) });
    },
    clearFailures: () => { failPlan = []; },
    readFile: (rel) => { const b = files.get(rel); return b ? Buffer.from(b) : null; },
    listFiles: () => [...files.keys()].sort(),
    tamper: (rel, fn) => {
      const b = files.get(rel);
      if (!b) throw new Error(`sim.tamper: no such file ${rel}`);
      files.set(rel, fn(Buffer.from(b)));
    },
    clearAudit: () => { audit.length = 0; },
    reset: () => { files.clear(); audit.length = 0; failPlan = []; }
  };
  return sim;
}
