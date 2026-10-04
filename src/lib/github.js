// GitHubStorageProvider — cloud backup via the GitHub Contents API.
//
// Auth: user-configured personal access token (Bearer). The token is sent ONLY
// to the configured API host (default api.github.com), never logged, never
// included in error messages (redacted), never written into artifacts.
//
// Repository layout (deterministic, basePath configurable):
//   <basePath>/manifest.json
//   <basePath>/backups/backup-<timestamp>-<id>.bbr
//
// Upload pipeline enforced here: artifact -> validate -> [encrypt decision made
// upstream] -> upload -> VERIFY REMOTE OBJECT (re-download + sha256 + git blob
// sha compare) -> success. An HTTP 2xx alone is NEVER treated as success.
//
// Policy: a PUBLIC repository only ever receives ENCRYPTED artifacts. The check
// runs in this layer (below the UI), so it cannot be bypassed by UI bugs.

import { TypedError, bytesToB64, sha256Hex } from './util.js';
import { assertUploadSafe, normalizeManifest } from './artifact.js';
import { BackupRef, StorageProvider } from './providers.js';

const API_VERSION = '2022-11-28';

// git blob sha1 = sha1("blob <len>\0<content>") — lets us verify the stored
// object independent of transport encoding.
async function gitBlobSha1(bytes) {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const buf = new Uint8Array(header.length + bytes.length);
  buf.set(header, 0);
  buf.set(bytes, header.length);
  const d = await crypto.subtle.digest('SHA-1', buf);
  return Array.from(new Uint8Array(d))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export class GitHubStorageProvider extends StorageProvider {
  static get id() {
    return 'github';
  }

  // cfg: { token, owner, repo, branch, basePath, apiBaseUrl (tests only) }
  constructor(cfg) {
    super();
    if (!cfg || typeof cfg.token !== 'string' || cfg.token.length === 0) {
      throw new TypedError(
        'ERR_NOT_CONFIGURED',
        'A GitHub personal access token is required.'
      );
    }
    this.token = cfg.token;
    // owner/repo are optional here so the provider can be used for
    // repository discovery (listRepositories). Repository-scoped operations
    // fail with ERR_NOT_CONFIGURED via #requireRepo() instead.
    this.owner = cfg.owner || null;
    this.repo = cfg.repo || null;
    this.branch = cfg.branch || null; // null = repo default branch (resolved on connect)
    this.basePath = (cfg.basePath || 'browser-backups').replace(
      /^\/+|\/+$/g,
      ''
    );
    this.apiBase = (cfg.apiBaseUrl || 'https://api.github.com').replace(
      /\/+$/,
      ''
    );
    this.repoInfo = null; // { private, defaultBranch, permissions, fullName }
    this.account = null; // { login }
  }

  #redact(text) {
    let s = String(text);
    if (this.token) s = s.split(this.token).join('***');
    return s;
  }

  #headers(extra = {}) {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      'Content-Type': 'application/json',
      ...extra,
    };
  }

  async #request(method, path, { body, raw = false, ref } = {}) {
    let url;
    if (path.startsWith('http://') || path.startsWith('https://')) {
      // Absolute URL (pagination `next` links): only ever follow URLs on the
      // configured API origin, so the Bearer token never leaves api.github.com.
      url = new URL(path);
      if (url.origin !== new URL(this.apiBase).origin) {
        throw new TypedError(
          'ERR_GITHUB_HTTP',
          'GitHub request rejected: pagination URL points to an unexpected host.'
        );
      }
    } else {
      url = new URL(`${this.apiBase}${path}`);
    }
    if (ref) url.searchParams.set('ref', ref);
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: this.#headers(
          raw ? { Accept: 'application/vnd.github.raw' } : {}
        ),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new TypedError(
        'ERR_NETWORK',
        `GitHub request failed (network error): ${this.#redact(e.message)}`
      );
    }
    if (res.ok) {
      if (raw)
        return {
          status: res.status,
          text: await res.text(),
          json: null,
          headers: res.headers,
        };
      const text = await res.text();
      let json;
      try {
        json = text ? JSON.parse(text) : null;
      } catch (e) {
        json = null;
      }
      return { status: res.status, text, json, headers: res.headers };
    }
    // error path — build a typed error with a SAFE message
    let msg = '';
    try {
      const j = await res.json();
      msg = j && j.message ? j.message : '';
    } catch (e) {
      /* non-JSON error body */
    }
    if (res.status === 401) {
      throw new TypedError(
        'ERR_GITHUB_AUTH',
        'GitHub authentication failed: the token was rejected (401). Check the personal access token.'
      );
    }
    if (res.status === 404) {
      throw new TypedError(
        'ERR_GITHUB_REPO_NOT_FOUND',
        'GitHub: repository or file not found (404). Check owner, repository, branch and path.'
      );
    }
    if (res.status === 403) {
      throw new TypedError(
        'ERR_GITHUB_FORBIDDEN',
        'GitHub request forbidden (403). The token may lack the required permissions, or a rate limit was hit.'
      );
    }
    if (res.status === 409 || res.status === 422) {
      throw new TypedError(
        'ERR_GITHUB_CONFLICT',
        `GitHub rejected the change (${res.status})${msg ? ': ' + this.#redact(msg) : '.'}`
      );
    }
    throw new TypedError(
      'ERR_GITHUB_HTTP',
      `GitHub request failed with HTTP ${res.status}${msg ? ': ' + this.#redact(msg) : '.'}`
    );
  }

  #requireRepo() {
    if (!this.owner || !this.repo) {
      throw new TypedError(
        'ERR_NOT_CONFIGURED',
        'Repository owner and name are required.'
      );
    }
  }

  #path(...parts) {
    this.#requireRepo(); // chokepoint of all content operations
    return `/repos/${[this.owner, this.repo, 'contents', ...parts.filter((p) => p !== undefined && p !== null)].join('/')}`;
  }

  // Parse an RFC 5988 Link header; return the URL of rel="next", or null.
  #nextLinkUrl(linkHeader) {
    if (!linkHeader) return null;
    for (const part of String(linkHeader).split(',')) {
      const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
      if (m) return m[1];
    }
    return null;
  }

  // Fetch a paginated collection, following RFC 5988 rel="next" links.
  // Accumulates array bodies; stops at the first page without a next link
  // or when maxPages is reached.
  async #getAllPages(path, { maxPages = 10 } = {}) {
    const items = [];
    let next = path;
    for (let page = 0; next && page < maxPages; page++) {
      const r = await this.#request('GET', next);
      if (Array.isArray(r.json)) items.push(...r.json);
      next = this.#nextLinkUrl(r.headers.get('link'));
    }
    return items;
  }

  // ---------- contract ----------

  // Lightweight token validation: GET /user only, no repository required.
  // Used by the "Connect" step before any repository is selected.
  async validateToken() {
    const me = await this.#request('GET', '/user');
    this.account = me.json && me.json.login ? { login: me.json.login } : null;
    return this.account;
  }

  async connect() {
    this.#requireRepo();
    const me = await this.#request('GET', '/user');
    this.account = me.json && me.json.login ? { login: me.json.login } : null;
    const info = await this.#request(
      'GET',
      `/repos/${this.owner}/${this.repo}`
    );
    const r = info.json || {};
    if (
      r.full_name &&
      r.full_name.toLowerCase() !== `${this.owner}/${this.repo}`.toLowerCase()
    ) {
      throw new TypedError(
        'ERR_GITHUB_REPO_NOT_FOUND',
        'GitHub: repository lookup returned an unexpected repository.'
      );
    }
    this.repoInfo = {
      fullName: r.full_name || `${this.owner}/${this.repo}`,
      private: !!r.private,
      defaultBranch: r.default_branch || 'main',
      permissions: r.permissions || {},
      visibility: r.visibility || (r.private ? 'private' : 'public'),
    };
    if (!this.branch) this.branch = this.repoInfo.defaultBranch;
    return {
      ok: true,
      provider: this.id,
      account: this.account,
      repo: this.repoInfo,
      branch: this.branch,
      basePath: this.basePath,
    };
  }

  // Repo visibility; connects lazily if not done yet.
  async ensureRepoInfo() {
    if (!this.repoInfo) await this.connect();
    return this.repoInfo;
  }

  manifestPath() {
    return `${this.basePath}/manifest.json`;
  }
  backupsDir() {
    return `${this.basePath}/backups`;
  }

  // ---------- repository/branch picker (no owner/repo required) ----------

  // Repositories the token can see, newest first (API already sorts).
  async listRepositories() {
    const repos = await this.#getAllPages(
      '/user/repos?per_page=100&sort=updated&direction=desc'
    );
    return repos
      .filter((r) => r && r.owner && r.owner.login && r.name && r.full_name)
      .map((r) => ({
        owner: r.owner.login,
        name: r.name,
        fullName: r.full_name,
        private: !!r.private,
        defaultBranch: r.default_branch || 'main',
        updatedAt: r.updated_at || null,
      }));
  }

  // Branch names of the configured repository.
  async listBranches() {
    this.#requireRepo();
    const branches = await this.#getAllPages(
      `/repos/${this.owner}/${this.repo}/branches?per_page=100`
    );
    return branches
      .filter((b) => b && typeof b.name === 'string')
      .map((b) => b.name);
  }

  async #getRemoteManifest() {
    let r;
    try {
      r = await this.#request('GET', this.#path(this.manifestPath()), {
        ref: this.branch,
        raw: true,
      });
    } catch (e) {
      if (e.code === 'ERR_GITHUB_REPO_NOT_FOUND') return { manifest: null }; // first upload
      throw e;
    }
    let manifest;
    try {
      manifest = normalizeManifest(JSON.parse(r.text));
    } catch (e) {
      throw new TypedError(
        'ERR_MALFORMED',
        'Remote manifest is unreadable (invalid JSON or foreign format).'
      );
    }
    return { manifest };
  }

  async #putFile(path, text, { message, sha = null } = {}) {
    const body = {
      message,
      content: bytesToB64(new TextEncoder().encode(text)),
      branch: this.branch,
      ...(sha ? { sha } : {}),
    };
    const r = await this.#request('PUT', this.#path(path), { body });
    const outSha =
      r.json && r.json.content && r.json.content.sha
        ? r.json.content.sha
        : null;
    return { blobSha: outSha };
  }

  async uploadBackup(
    artifact,
    { plaintextAllowed = false, message = null } = {}
  ) {
    const repoInfo = await this.ensureRepoInfo();
    // ---- plaintext safety guard (enforced BELOW the UI, in the storage layer) ----
    assertUploadSafe(artifact, {
      repoPublic: repoInfo.private === false,
      plaintextAllowed,
    });

    const filePath = `${this.basePath}/backups/${artifact.filename}`;
    const blobSha = await gitBlobSha1(artifact.bytes);
    const commitMsg =
      message ||
      `browser-backup: add ${artifact.id} (${artifact.encrypted ? 'encrypted' : 'plaintext'})`;

    const put = await this.#putFile(filePath, artifact.text, {
      message: commitMsg,
    });

    // ---- verify the remote object: re-download and compare byte digests ----
    const remote = await this.#request('GET', this.#path(filePath), {
      ref: this.branch,
      raw: true,
    });
    const remoteBytes = new TextEncoder().encode(remote.text);
    const remoteSha256 = await sha256Hex(remote.text);
    if (remoteSha256 !== artifact.sha256Hex) {
      throw new TypedError(
        'ERR_VERIFY_FAILED',
        'Upload verification failed: the remote artifact does not match the local artifact (sha256 mismatch).'
      );
    }
    const remoteBlobSha = await gitBlobSha1(remoteBytes);
    if (remoteBlobSha !== blobSha || (put.blobSha && put.blobSha !== blobSha)) {
      throw new TypedError(
        'ERR_VERIFY_FAILED',
        'Upload verification failed: git blob id mismatch.'
      );
    }
    return {
      verified: true,
      id: artifact.id,
      path: filePath,
      sha256Hex: artifact.sha256Hex,
      gitBlobSha: remoteBlobSha,
      sizeBytes: artifact.sizeBytes,
    };
  }

  // Manifest-first listing; falls back to listing the backups/ directory when
  // the manifest is missing or unreadable (entries get minimal metadata).
  async listBackups() {
    try {
      const { manifest } = await this.#getRemoteManifest();
      if (manifest && manifest.backups) {
        return manifest.backups.map(
          (b) => new BackupRef({ ...b, provider: this.id })
        );
      }
    } catch (e) {
      if (e.code !== 'ERR_MALFORMED') throw e;
    }
    // fallback: directory listing
    let listing;
    try {
      listing = await this.#request('GET', this.#path(this.backupsDir()), {
        ref: this.branch,
      });
    } catch (e) {
      if (e.code === 'ERR_GITHUB_REPO_NOT_FOUND') return [];
      throw e;
    }
    const files = Array.isArray(listing.json)
      ? listing.json.filter((f) => f.type === 'file' && f.name.endsWith('.bbr'))
      : [];
    return files.map(
      (f) =>
        new BackupRef({
          id: f.name.replace(/\.bbr$/, '').replace(/^backup-/, ''),
          filename: `${this.backupsDir()}/${f.name}`,
          createdAt: '',
          sizeBytes: f.size,
          format: null,
          encrypted: null,
          integrity: null,
          provider: this.id,
          listingOnly: true,
        })
    );
  }

  // Resolve a backup reference: object {id|filename} or string (a path when it
  // contains '/', otherwise a backup id → deterministic default filename).
  // id is authoritative — the repository layout is deterministic.
  #resolvePath(ref) {
    if (typeof ref === 'string') {
      if (ref.includes('/')) return ref;
      return `${this.backupsDir()}/backup-${ref}.bbr`;
    }
    if (ref && typeof ref === 'object') {
      if (ref.id) return `${this.backupsDir()}/backup-${ref.id}.bbr`;
      if (ref.filename && ref.filename.includes('/')) return ref.filename;
    }
    throw new TypedError('ERR_MALFORMED', 'Invalid backup reference.');
  }

  async #fileSha(path) {
    const r = await this.#request('GET', this.#path(path), {
      ref: this.branch,
    });
    return r.json.sha;
  }

  async downloadBackup(ref) {
    const path = this.#resolvePath(ref);
    const r = await this.#request('GET', this.#path(path), {
      ref: this.branch,
      raw: true,
    });
    const text = r.text;
    if (!text || text.length === 0) {
      throw new TypedError('ERR_EMPTY_FILE', 'Downloaded backup is empty.');
    }
    return { text, sha256Hex: await sha256Hex(text) };
  }

  async deleteBackup(ref) {
    const path = this.#resolvePath(ref);
    let sha;
    try {
      sha = await this.#fileSha(path);
    } catch (e) {
      if (e.code === 'ERR_GITHUB_REPO_NOT_FOUND') {
        throw new TypedError(
          'ERR_NOT_FOUND',
          `Remote backup not found: ${path}`
        );
      }
      throw e;
    }
    await this.#request('DELETE', this.#path(path), {
      body: {
        message: `browser-backup: delete ${path.split('/').pop()}`,
        sha,
        branch: this.branch,
      },
    });
    return true;
  }

  async getMetadata(ref) {
    const all = await this.listBackups();
    const id = typeof ref === 'string' ? ref : ref.id;
    const m = all.find(
      (b) =>
        b.id === id ||
        b.filename === (typeof ref === 'object' ? ref.filename : undefined)
    );
    if (!m)
      throw new TypedError(
        'ERR_NOT_FOUND',
        `Remote backup "${id}" not found in manifest.`
      );
    return m;
  }

  async verifyRemoteObject(ref, expectedSha256) {
    try {
      const path = this.#resolvePath(ref);
      const r = await this.#request('GET', this.#path(path), {
        ref: this.branch,
        raw: true,
      });
      const sha = await sha256Hex(r.text);
      const blobSha = await gitBlobSha1(new TextEncoder().encode(r.text));
      return {
        ok: sha === expectedSha256,
        sha256Hex: sha,
        gitBlobSha: blobSha,
        expectedSha256,
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ---------- manifest operations ----------

  async readManifest() {
    const { manifest, sha } = await this.#getRemoteManifest();
    return { manifest, sha };
  }

  async writeManifest(manifest, { sha = null } = {}) {
    const m = normalizeManifest(manifest);
    m.updatedAt = new Date().toISOString();
    let currentSha = sha;
    if (currentSha === null) {
      try {
        currentSha = await this.#fileSha(this.manifestPath());
      } catch (e) {
        if (e.code !== 'ERR_GITHUB_REPO_NOT_FOUND') throw e;
        currentSha = null;
      }
    }
    await this.#putFile(this.manifestPath(), JSON.stringify(m, null, 2), {
      message: `browser-backup: update manifest (${m.backups.length} backups)`,
      sha: currentSha,
    });
    return m;
  }
}
