// pagelib.js — PAGE-CONTEXT library (main world). Injected by the extension via
// chrome.debugger Runtime.evaluate (source string) or chrome.scripting files.
// Provides globalThis.__BBR: type-preserving serializer, storage readers,
// restorers and wipes for ALL site-visible storage:
//   localStorage, sessionStorage, IndexedDB (incl. key-generator probe),
//   Cache Storage, Service Worker registrations (+ script bytes),
//   Origin Private File System (OPFS), Storage Buckets (IDB + caches + OPFS).
//
// The same code performs seed / backup / restore / verify so comparisons are
// apples-to-apples. It must stay dependency-free plain browser JS.
//
// Transport safety: chrome.debugger's Mojo transport corrupts lone surrogates
// (proven by research/cdp-storage). All results cross the boundary as
// JSON.stringify text (ASCII-safe escapes) pulled in chunks, so corruption
// cannot occur; __BBR strings are additionally WTF-16-safe by design.
(function () {
  if (globalThis.__BBR) return;

  // ---------- binary helpers ----------
  function abToB64(buf) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    }
    return btoa(s);
  }
  function b64ToAb(b64) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8.buffer;
  }
  // WTF-16LE safe string codec (used for strings containing lone surrogates).
  function wtf16B64(s) {
    const u8 = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      u8[i * 2] = c & 0xff;
      u8[i * 2 + 1] = (c >> 8) & 0xff;
    }
    return abToB64(u8);
  }
  function b64Wtf16(b64) {
    const u8 = new Uint8Array(b64ToAb(b64));
    // WTF-16LE: two bytes per UTF-16 code unit. Rebuild code units by pairing
    // bytes (little-endian), then chunk String.fromCharCode calls to stay far
    // below the argument-count limit.
    let out = '';
    const CH = 0x4000; // code units per apply() call
    for (let i = 0; i < u8.length; i += 2 * CH) {
      const end = Math.min(u8.length, i + 2 * CH);
      const codes = new Uint16Array(u8.buffer.slice(i, end));
      out += String.fromCharCode.apply(null, codes);
    }
    return out;
  }
  function hasLoneSurrogate(s) {
    if (typeof s !== 'string') return false;
    for (const ch of s) {
      const c = ch.codePointAt(0);
      if (c >= 0xd800 && c <= 0xdfff) return true;
    }
    return false;
  }
  // Wrap a possibly-surrogate string for safe transport; decode via maybeSur() on read-back.
  function encStr(s) {
    return hasLoneSurrogate(s) ? { __bbrSur: wtf16B64(s) } : s;
  }
  function decStr(v) {
    return v && typeof v === 'object' && typeof v.__bbrSur === 'string' ? b64Wtf16(v.__bbrSur) : v;
  }
  function encStrMap(map) {
    const o = {};
    for (const k of Object.keys(map)) o[encStr(k)] = encStr(map[k]);
    return o;
  }
  function decStrMap(map) {
    const o = {};
    for (const k of Object.keys(map || {})) o[decStr(k)] = decStr(map[k]);
    return o;
  }

  // ---------- value encoder (async; JSON-safe tagged encoding) ----------
  async function enc(x) {
    if (x === null) return { t: 'null' };
    const ty = typeof x;
    if (ty === 'undefined') return { t: 'undef' };
    if (ty === 'boolean') return { t: 'bool', v: x };
    if (ty === 'number') {
      if (Number.isNaN(x)) return { t: 'num', s: 'NaN' };
      if (x === Infinity) return { t: 'num', s: 'Infinity' };
      if (x === -Infinity) return { t: 'num', s: '-Infinity' };
      if (Object.is(x, -0)) return { t: 'num', s: '-0' };
      return { t: 'num', v: x };
    }
    if (ty === 'string') return { t: 'str', v: encStr(x) };
    if (x instanceof Date) return { t: 'date', v: x.getTime() };
    if (x instanceof RegExp) return { t: 're', v: [x.source, x.flags] };
    if (x instanceof ArrayBuffer) return { t: 'ab', v: abToB64(x) };
    if (ArrayBuffer.isView(x)) {
      return { t: 'tv', c: x.constructor.name, v: abToB64(x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength)) };
    }
    if (typeof File !== 'undefined' && x instanceof File) {
      const buf = await x.arrayBuffer();
      return { t: 'file', name: encStr(x.name), lastModified: x.lastModified, type: x.type, v: abToB64(buf) };
    }
    if (typeof Blob !== 'undefined' && x instanceof Blob) {
      const buf = await x.arrayBuffer();
      return { t: 'blob', type: x.type, v: abToB64(buf) };
    }
    if (x instanceof Map) {
      const arr = [];
      for (const [k, v] of x) arr.push([await enc(k), await enc(v)]);
      return { t: 'map', v: arr };
    }
    if (x instanceof Set) {
      const arr = [];
      for (const v of x) arr.push(await enc(v));
      return { t: 'set', v: arr };
    }
    if (Array.isArray(x)) {
      const arr = [];
      for (const v of x) arr.push(await enc(v));
      return { t: 'arr', v: arr };
    }
    if (ty === 'object') {
      const o = {};
      for (const k of Object.keys(x)) o[k] = await enc(x[k]);
      return { t: 'obj', v: o };
    }
    return { t: 'unsupported', s: String(x) };
  }

  function dec(t) {
    switch (t.t) {
      case 'null': return null;
      case 'undef': return undefined;
      case 'bool': return t.v;
      case 'num':
        if (t.s === 'NaN') return NaN;
        if (t.s === 'Infinity') return Infinity;
        if (t.s === '-Infinity') return -Infinity;
        if (t.s === '-0') return -0;
        return t.v;
      case 'str': return decStr(t.v);
      case 'date': return new Date(t.v);
      case 're': return new RegExp(t.v[0], t.v[1]);
      case 'ab': return b64ToAb(t.v);
      case 'tv': {
        const buf = b64ToAb(t.v);
        if (t.c === 'Uint8Array') return new Uint8Array(buf);
        if (t.c === 'Int8Array') return new Int8Array(buf);
        if (t.c === 'Uint16Array') return new Uint16Array(buf);
        if (t.c === 'Int16Array') return new Int16Array(buf);
        if (t.c === 'Uint32Array') return new Uint32Array(buf);
        if (t.c === 'Int32Array') return new Int32Array(buf);
        if (t.c === 'Float32Array') return new Float32Array(buf);
        if (t.c === 'Float64Array') return new Float64Array(buf);
        if (t.c === 'BigInt64Array') return new BigInt64Array(buf);
        if (t.c === 'BigUint64Array') return new BigUint64Array(buf);
        if (t.c === 'DataView') return new DataView(buf);
        return new Uint8Array(buf);
      }
      case 'blob': return new Blob([b64ToAb(t.v)], { type: t.type || '' });
      case 'file': return new File([b64ToAb(t.v)], decStr(t.name), { type: t.type || '', lastModified: t.lastModified });
      case 'map': {
        const m = new Map();
        for (const [k, v] of t.v) m.set(dec(k), dec(v));
        return m;
      }
      case 'set': return new Set(t.v.map(dec));
      case 'arr': return t.v.map(dec);
      case 'obj': {
        const o = {};
        for (const k of Object.keys(t.v)) o[k] = dec(t.v[k]);
        return o;
      }
      default: throw new Error('unsupported tag: ' + t.t);
    }
  }

  // ---------- IDB key encoder ----------
  function encKey(k) {
    if (typeof k === 'number') {
      if (Number.isNaN(k)) return { t: 'num', s: 'NaN' };
      if (k === Infinity) return { t: 'num', s: 'Infinity' };
      if (Object.is(k, -0)) return { t: 'num', s: '-0' };
      return { t: 'num', v: k };
    }
    if (typeof k === 'string') return { t: 'str', v: encStr(k) };
    if (k instanceof Date) return { t: 'date', v: k.getTime() };
    if (Array.isArray(k)) return { t: 'arr', v: k.map(encKey) };
    if (k instanceof ArrayBuffer) return { t: 'bin', v: abToB64(k) };
    if (ArrayBuffer.isView(k)) return { t: 'bin', v: abToB64(k.buffer.slice(k.byteOffset, k.byteOffset + k.byteLength)) };
    throw new Error('invalid IDB key type: ' + typeof k);
  }
  function decKey(t) {
    switch (t.t) {
      case 'num':
        if (t.s === 'Infinity') return Infinity;
        if (t.s === '-0') return -0;
        return t.v;
      case 'str': return decStr(t.v);
      case 'date': return new Date(t.v);
      case 'arr': return t.v.map(decKey);
      case 'bin': return new Uint8Array(b64ToAb(t.v));
      default: throw new Error('bad key tag ' + t.t);
    }
  }

  // ---------- IDB plumbing ----------
  function openDB(idbFactory, name, version) {
    return new Promise((res, rej) => {
      const rq = idbFactory.open(name, version);
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
      rq.onblocked = () => rej(new Error('open blocked'));
    });
  }
  function idbDelete(idbFactory, name) {
    return new Promise((res) => {
      const rq = idbFactory.deleteDatabase(name);
      rq.onsuccess = () => res(true);
      rq.onerror = () => res(false);
      rq.onblocked = () => res(false);
    });
  }

  async function readIDB(idbFactory) {
    const F = idbFactory || indexedDB;
    const names = (await F.databases()).map((d) => d.name);
    names.sort();
    const out = [];
    for (const name of names) {
      try {
        const ver = await new Promise((res, rej) => {
          const rq = F.open(name);
          rq.onsuccess = () => { res(rq.result.version); rq.result.close(); };
          rq.onerror = () => rej(rq.error);
        });
        const db = await openDB(F, name, ver);
        const storeNames = [...db.objectStoreNames].sort();
        const stores = [];
        for (const sname of storeNames) {
          try {
            const schema = { name: sname };
            const rows = [];
            await new Promise((res, rej) => {
              const tx = db.transaction(sname, 'readonly');
              const st = tx.objectStore(sname);
              schema.keyPath = st.keyPath === null ? null : JSON.parse(JSON.stringify(st.keyPath));
              schema.autoIncrement = st.autoIncrement;
              schema.indexes = [...st.indexNames].sort().map((n) => {
                const ix = st.index(n);
                return { name: n, keyPath: ix.keyPath === null ? null : JSON.parse(JSON.stringify(ix.keyPath)), unique: ix.unique, multiEntry: ix.multiEntry };
              });
              const rq = st.openCursor();
              rq.onsuccess = (e) => {
                const c = e.target.result;
                if (c) { rows.push({ rawKey: c.key, rawValue: c.value }); c.continue(); }
                else res();
              };
              rq.onerror = () => rej(rq.error);
            });
            const records = [];
            for (const r of rows) records.push({ k: encKey(r.rawKey), v: await enc(r.rawValue) });
            // Measure the key generator (page-side; CDP IndexedDB domain is not
            // available through chrome.debugger). Probe AFTER reading rows.
            if (schema.autoIncrement) {
              try {
                const g = await probeAutoIncrementIn(db, sname);
                schema.keyGeneratorValue = g;
              } catch (e) { schema.keyGeneratorError = String(e && e.message || e); }
            }
            stores.push({ ...schema, records });
          } catch (err) {
            stores.push({ name: sname, error: String(err) });
          }
        }
        db.close();
        out.push({ name: encStr(name), version: ver, stores });
      } catch (err) {
        out.push({ name: encStr(name), error: String(err) });
      }
    }
    return out;
  }

  // Returns the CURRENT value of the autoIncrement generator for a store by
  // inserting a probe row and deleting it (generator is not otherwise readable
  // from page context). The generator stays at probed+1 afterwards, which the
  // restore bump-trick compensates for.
  function probeAutoIncrementIn(db, storeName) {
    return new Promise((res, rej) => {
      let key = null;
      const tx = db.transaction(storeName, 'readwrite');
      const st = tx.objectStore(storeName);
      const rq = st.put('__bbr_probe_row__');
      rq.onsuccess = () => { key = rq.result; };
      tx.oncomplete = () => {
        const tx2 = db.transaction(storeName, 'readwrite');
        tx2.objectStore(storeName).delete(key);
        tx2.oncomplete = () => res(key);
        tx2.onerror = () => rej(tx2.error);
      };
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error || new Error('tx abort'));
    });
  }

  // ---------- generic Cache Storage reader (works for origin + buckets) ----------
  function headersOf(h) {
    const o = {};
    for (const [k, v] of h.entries()) o[k] = v;
    return o;
  }
  async function readCacheStorage(cacheStorage) {
    const names = (await cacheStorage.keys()).sort();
    const out = [];
    for (const name of names) {
      try {
        const c = await cacheStorage.open(name);
        const reqs = await c.keys();
        const entries = [];
        for (const req of reqs) {
          const res = await c.match(req);
          if (!res) { entries.push({ url: req.url, method: req.method, error: 'match-failed' }); continue; }
          const buf = await res.arrayBuffer();
          entries.push({
            url: req.url,
            method: req.method,
            status: res.status,
            statusText: res.statusText,
            headers: headersOf(res.headers),
            bodyB64: abToB64(buf),
            bodyLen: buf.byteLength,
          });
        }
        entries.sort((a, b) => (a.url + a.method).localeCompare(b.url + b.method));
        out.push({ name: encStr(name), entries });
      } catch (err) {
        out.push({ name: encStr(name), error: String(err) });
      }
    }
    return out;
  }
  const BAD_BODY_STATUS = { 204: 1, 205: 1, 304: 1 };
  async function restoreCacheStorage(cacheStorage, list, mode) {
    const results = [];
    for (const cs of list) {
      try {
        if (mode === 'replace') await cacheStorage.delete(cs.name);
        const c = await cacheStorage.open(decStr(cs.name));
        let put = 0; const errors = [];
        for (const e of cs.entries) {
          try {
            if (e.error) { errors.push({ url: e.url, error: e.error }); continue; }
            let res;
            try {
              const body = BAD_BODY_STATUS[e.status] ? null : (e.bodyB64 ? b64ToAb(e.bodyB64) : null);
              res = new Response(body, { status: e.status, statusText: e.statusText || '', headers: e.headers || {} });
            } catch (err) {
              errors.push({ url: e.url, error: 'construct-response: ' + String(err) });
              continue;
            }
            let req;
            try {
              req = new Request(e.url, { method: e.method || 'GET' });
            } catch (err) {
              req = new Request(e.url, { method: e.method || 'GET' });
            }
            await c.put(req, res);
            put++;
          } catch (err) {
            errors.push({ url: e.url, error: String(err) });
          }
        }
        results.push({ cache: decStr(cs.name), ok: true, put, errors });
      } catch (err) {
        results.push({ cache: decStr(cs.name), ok: false, error: String(err) });
      }
    }
    return results;
  }

  // ---------- Service worker reader ----------
  async function readSWs(fetchScript) {
    const regs = await navigator.serviceWorker.getRegistrations();
    regs.sort((a, b) => a.scope.localeCompare(b.scope));
    const out = [];
    for (const r of regs) {
      const w = r.active || r.waiting || r.installing;
      const item = {
        scope: r.scope,
        scriptURL: w ? w.scriptURL : null,
        updateViaCache: r.updateViaCache,
        state: w ? w.state : null,
        states: {
          active: r.active ? r.active.state : null,
          waiting: r.waiting ? r.waiting.state : null,
          installing: r.installing ? r.installing.state : null,
        },
        scriptB64: null,
        scriptError: null,
      };
      if (fetchScript && item.scriptURL) {
        try {
          const res = await fetch(item.scriptURL, { cache: 'no-store' });
          const buf = await res.arrayBuffer();
          item.scriptB64 = abToB64(buf);
        } catch (err) {
          item.scriptError = String(err);
        }
      }
      out.push(item);
    }
    return out;
  }

  // ---------- OPFS (origin + bucket-scoped) ----------
  async function walkDir(dir, path, files, dirs) {
    const names = [];
    for await (const [name, handle] of dir.entries()) {
      names.push(name);
      if (handle.kind === 'directory') {
        dirs.push(encStr(path + name + '/'));
        await walkDir(handle, path + name + '/', files, dirs);
      } else {
        const f = await handle.getFile();
        const buf = new Uint8Array(await f.arrayBuffer());
        files.push({
          path: encStr(path + name),
          size: f.size,
          lastModified: f.lastModified,
          type: f.type || '',
          b64: abToB64(buf),
        });
      }
    }
    names.sort();
    if (names.length) dirs.push('__order__' + encStr(path) + '::' + names.map(encStr).map(JSON.stringify).join(','));
  }
  async function readOPFS(rootDir) {
    const files = [];
    const dirs = [];
    await walkDir(rootDir, '', files, dirs);
    return { files, dirs: dirs.sort() };
  }
  async function restoreOPFS(rootDir, manifest, mode) {
    const stats = { filesWritten: 0, dirsCreated: 0, deleted: 0, errors: [] };
    if (mode === 'replace') {
      for await (const [name] of rootDir.entries()) {
        try { await rootDir.removeEntry(name, { recursive: true }); stats.deleted++; }
        catch (e) { stats.errors.push('wipe ' + name + ': ' + e.message); }
      }
    }
    for (const p of (manifest.dirs || []).filter((d) => !d.startsWith('__order__'))) {
      let parent = rootDir;
      for (const seg of decStr(p).split('/').filter(Boolean)) parent = await parent.getDirectoryHandle(seg, { create: true });
      stats.dirsCreated++;
    }
    for (const f of manifest.files || []) {
      try {
        const segs = decStr(f.path).split('/');
        const name = segs.pop();
        let dir = rootDir;
        for (const s of segs) dir = await dir.getDirectoryHandle(s, { create: true });
        const fh = await dir.getFileHandle(name, { create: true });
        const w = await fh.createWritable();
        await w.write(new Uint8Array(b64ToAb(f.b64)));
        await w.close();
        stats.filesWritten++;
      } catch (e) {
        stats.errors.push(decStr(f.path) + ': ' + e.message);
      }
    }
    return stats;
  }
  async function wipeOPFS(rootDir) {
    let n = 0;
    for await (const [name] of rootDir.entries()) {
      await rootDir.removeEntry(name, { recursive: true }).catch(() => {});
      n++;
    }
    return { removed: n };
  }

  // ---------- Storage Buckets ----------
  async function listBuckets() {
    const k = navigator.storageBuckets.keys();
    if (k && typeof k[Symbol.asyncIterator] === 'function') {
      const arr = [];
      for await (const n of k) arr.push(n);
      return arr;
    }
    const arr = await k;
    return Array.isArray(arr) ? arr.slice() : Array.from(arr || []);
  }
  async function readBuckets() {
    const out = { buckets: [] };
    const names = (await listBuckets()).sort();
    for (const name of names) {
      const bucket = await navigator.storageBuckets.open(name);
      const info = { name: encStr(name), handleProps: {} };
      for (const k of ['name', 'durability']) {
        try { info.handleProps[k] = typeof bucket[k] === 'function' ? 'fn' : (bucket[k] ?? null); } catch (e) { info.handleProps[k] = 'ERR:' + e.message; }
      }
      try { info.persisted = await bucket.persisted(); } catch (e) { info.persisted = null; }
      try { info.expires = await bucket.expires(); } catch (e) { info.expires = null; }
      info.indexedDB = await readIDB(bucket.indexedDB);
      info.cacheStorage = await readCacheStorage(bucket.caches);
      try {
        info.opfs = await readOPFS(await bucket.getDirectory());
      } catch (e) {
        info.opfs = { error: String(e), files: [], dirs: [] };
      }
      info.apiPresence = {
        indexedDB: typeof bucket.indexedDB,
        caches: typeof bucket.caches,
        getDirectory: typeof bucket.getDirectory,
        persist: typeof bucket.persist,
        estimate: typeof bucket.estimate,
        setExpires: typeof bucket.setExpires,
        open: typeof bucket.open,
      };
      out.buckets.push(info);
    }
    return out;
  }
  async function restoreBuckets(manifest, mode) {
    const stats = { bucketsOpened: [], dbsRestored: 0, records: 0, cacheEntries: 0, opfsFiles: 0, opfsDirs: 0, deleted: 0, errors: [] };
    const existing = mode === 'replace' ? new Set() : new Set(await listBuckets());
    if (mode === 'replace') {
      for (const n of await listBuckets()) {
        try { await navigator.storageBuckets.delete(n); stats.deleted++; }
        catch (e) { stats.errors.push('delete ' + n + ': ' + e.message); }
      }
    }
    for (const spec of manifest.buckets || []) {
      try {
        const name = decStr(spec.name);
        const opts = spec.requested && Object.keys(spec.requested).length ? spec.requested : undefined;
        const bucket = opts ? await navigator.storageBuckets.open(name, opts) : await navigator.storageBuckets.open(name);
        stats.bucketsOpened.push(name);
        const existed = existing.has(name);
        for (const dbSpec of spec.indexedDB || []) {
          if (existed && mode !== 'replace') {
            const have = await bucket.indexedDB.databases().then((l) => l.map((d) => d.name)).catch(() => []);
            if (have.includes(decStr(dbSpec.name))) { stats.errors.push(`skip existing db ${decStr(dbSpec.name)} in bucket ${name}`); continue; }
          }
          const db = await new Promise((res, rej) => {
            const rq = bucket.indexedDB.open(decStr(dbSpec.name), dbSpec.version);
            rq.onupgradeneeded = () => {
              const d = rq.result;
              for (const s of dbSpec.stores) {
                if (d.objectStoreNames.contains(decStr(s.name))) continue;
                const so = { autoIncrement: !!s.autoIncrement };
                if (s.keyPath !== null) so.keyPath = s.keyPath;
                const st = d.createObjectStore(decStr(s.name), so);
                for (const ix of s.indexes || []) st.createIndex(ix.name, ix.keyPath, { unique: !!ix.unique, multiEntry: !!ix.multiEntry });
              }
            };
            rq.onsuccess = () => res(rq.result);
            rq.onerror = () => rej(rq.error);
            rq.onblocked = () => rej(new Error('blocked'));
          });
          for (const s of dbSpec.stores) {
            if (!s.records || !s.records.length) continue;
            await new Promise((res, rej) => {
              const tx = db.transaction(decStr(s.name), 'readwrite');
              const st = tx.objectStore(decStr(s.name));
              for (const r of s.records) {
                const val = dec(r.v);
                if (s.keyPath !== null) st.put(val);
                else st.put(val, decKey(r.k));
                stats.records++;
              }
              tx.oncomplete = res;
              tx.onerror = () => rej(tx.error);
            });
          }
          // key-generator bump (same trick as origin IDB)
          for (const s of dbSpec.stores) {
            if (s.autoIncrement && s.keyGeneratorValue) {
              try {
                const target = s.keyGeneratorValue;
                const db2 = await openDB(bucket.indexedDB, decStr(dbSpec.name));
                await new Promise((res, rej) => {
                  const tx = db2.transaction(decStr(s.name), 'readwrite');
                  const st = tx.objectStore(decStr(s.name));
                  const rq = st.put('__bbr_bump__', target - 1);
                  rq.onsuccess = () => st.delete(target - 1);
                  tx.oncomplete = res;
                  tx.onerror = () => rej(tx.error);
                });
                db2.close();
              } catch (e) { stats.errors.push('bucket counterFix ' + name + '/' + decStr(s.name) + ': ' + e.message); }
            }
          }
          db.close();
          stats.dbsRestored++;
        }
        const cacheRes = await restoreCacheStorage(bucket.caches, spec.cacheStorage || [], existed && mode !== 'replace' ? 'merge' : 'replace');
        for (const r of cacheRes) stats.cacheEntries += r.put || 0;
        const opfsStats = await restoreOPFS(await bucket.getDirectory(), spec.opfs || { files: [], dirs: [] }, existed && mode !== 'replace' ? 'merge' : 'replace');
        stats.opfsFiles += opfsStats.filesWritten;
        stats.opfsDirs += opfsStats.dirsCreated;
      } catch (e) {
        stats.errors.push(decStr(spec.name) + ': ' + e.message);
      }
    }
    return stats;
  }
  async function wipeBuckets() {
    const names = await listBuckets();
    let n = 0;
    for (const name of names) {
      try { await navigator.storageBuckets.delete(name); n++; } catch (e) { /* ignore */ }
    }
    return { deleted: n };
  }

  // ---------- localStorage / sessionStorage ----------
  function readLS() {
    const ls = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      ls[encStr(k)] = encStr(localStorage.getItem(k));
    }
    return ls;
  }
  function readSS() {
    const ss = {};
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      ss[encStr(k)] = encStr(sessionStorage.getItem(k));
    }
    return ss;
  }
  function restoreLS(map, mode) {
    if (mode === 'replace') localStorage.clear();
    const m = decStrMap(map);
    let n = 0;
    for (const k of Object.keys(m)) { localStorage.setItem(k, m[k]); n++; }
    return { written: n, mode: mode || 'merge' };
  }
  function restoreSS(map, mode) {
    if (mode === 'replace') sessionStorage.clear();
    const m = decStrMap(map);
    let n = 0;
    for (const k of Object.keys(m)) { sessionStorage.setItem(k, m[k]); n++; }
    return { written: n };
  }

  // ---------- IDB restore (origin level) ----------
  async function restoreIDB(dbs, opts) {
    opts = opts || {};
    const results = [];
    const existingNames = opts.replace ? [] : (await indexedDB.databases()).map((d) => d.name);
    for (const spec of dbs) {
      const name = decStr(spec.name);
      try {
        if (!opts.replace && existingNames.includes(name)) {
          results.push({ db: name, ok: true, skippedExisting: true, records: 0 });
          continue;
        }
        await idbDelete(indexedDB, name);
        const db = await new Promise((res, rej) => {
          const rq = indexedDB.open(name, spec.version);
          rq.onupgradeneeded = () => {
            const d = rq.result;
            for (const s of spec.stores) {
              if (s.error) continue;
              const stOpts = { autoIncrement: !!s.autoIncrement };
              if (s.keyPath !== null) stOpts.keyPath = s.keyPath;
              const st = d.createObjectStore(decStr(s.name), stOpts);
              for (const ix of s.indexes || []) {
                st.createIndex(ix.name, ix.keyPath, { unique: !!ix.unique, multiEntry: !!ix.multiEntry });
              }
            }
          };
          rq.onsuccess = () => res(rq.result);
          rq.onerror = () => rej(rq.error);
          rq.onblocked = () => rej(new Error('open blocked'));
        });
        for (const s of spec.stores) {
          if (s.error || !s.records || !s.records.length) continue;
          await new Promise((res, rej) => {
            const tx = db.transaction(decStr(s.name), 'readwrite');
            const st = tx.objectStore(decStr(s.name));
            for (const r of s.records) {
              const val = dec(r.v);
              if (s.keyPath !== null) st.put(val);
              else st.put(val, decKey(r.k));
            }
            tx.oncomplete = res;
            tx.onerror = () => rej(tx.error);
            tx.onabort = () => rej(tx.error || new Error('tx abort'));
          });
        }
        db.close();
        results.push({ db: name, ok: true, records: spec.stores.reduce((a, s) => a + ((s.records && s.records.length) || 0), 0) });
      } catch (err) {
        results.push({ db: name, ok: false, error: String(err) });
      }
    }
    // key-generator bump trick: put a row at target-1, delete it; generator stays at target.
    for (const spec of dbs) {
      for (const s of spec.stores) {
        if (s.error || !s.autoIncrement || !s.keyGeneratorValue) continue;
        const dbName = decStr(spec.name);
        const storeName = decStr(s.name);
        const target = s.keyGeneratorValue;
        try {
          const db = await openDB(indexedDB, dbName);
          await new Promise((res, rej) => {
            const tx = db.transaction(storeName, 'readwrite');
            const st = tx.objectStore(storeName);
            const rq = st.put('__bbr_bump__', target - 1);
            rq.onsuccess = () => st.delete(target - 1);
            tx.oncomplete = res;
            tx.onerror = () => rej(tx.error);
            tx.onabort = () => rej(tx.error || new Error('tx abort'));
          });
          db.close();
          results.push({ counterFix: dbName + '::' + storeName, target, ok: true });
        } catch (err) {
          results.push({ counterFix: dbName + '::' + storeName, target, ok: false, error: String(err) });
        }
      }
    }
    return results;
  }

  // ---------- Service Worker restore ----------
  function waitActive(reg, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 15000);
    return new Promise((res) => {
      const check = () => {
        if (reg.active && reg.active.state === 'activated') return res(true);
        if (Date.now() > deadline) return res(false);
        setTimeout(check, 200);
      };
      check();
    });
  }
  async function restoreSW(list) {
    const results = [];
    for (const r of list) {
      try {
        const opts = { scope: r.scope };
        if (r.updateViaCache && r.updateViaCache !== 'imports') opts.updateViaCache = r.updateViaCache;
        const reg = await navigator.serviceWorker.register(r.scriptURL, opts);
        const active = await waitActive(reg);
        results.push({ scope: r.scope, ok: true, activated: active });
      } catch (err) {
        results.push({ scope: r.scope, ok: false, error: String(err) });
      }
    }
    return results;
  }

  // ---------- combined read / restore / wipe ----------
  // opts: { fetchScript: bool, opfs: bool, buckets: bool, sessionStorage: bool, serviceWorkers: bool }
  // sessionStorage and serviceWorkers default to true; set false to skip
  // capture entirely (they are not reliably restorable — see restoreSiteData).
  async function readSiteAll(opts) {
    opts = opts || {};
    const out = { origin: location.origin };
    // Each block is independent: an error-page document (opaque origin) denies
    // storage access with SecurityError — record it instead of aborting so the
    // per-origin snapshot degrades gracefully.
    try { out.localStorage = readLS(); } catch (e) { out.localStorage = {}; out.errors = out.errors || []; out.errors.push('localStorage: ' + e.message); }
    if (opts.sessionStorage === false) { out.sessionStorage = {}; out.skipped = (out.skipped || []).concat('sessionStorage'); }
    else { try { out.sessionStorage = readSS(); } catch (e) { out.sessionStorage = {}; out.errors = out.errors || []; out.errors.push('sessionStorage: ' + e.message); } }
    try { out.indexedDB = await readIDB(indexedDB); } catch (e) { out.indexedDB = []; out.errors = out.errors || []; out.errors.push('indexedDB: ' + e.message); }
    try { out.cacheStorage = await readCacheStorage(caches); } catch (e) { out.cacheStorage = []; out.errors = out.errors || []; out.errors.push('cacheStorage: ' + e.message); }
    if (opts.serviceWorkers === false) { out.serviceWorkers = []; out.skipped = (out.skipped || []).concat('serviceWorkers'); }
    else { try { out.serviceWorkers = await readSWs(!!opts.fetchScript); } catch (e) { out.serviceWorkers = []; out.errors = out.errors || []; out.errors.push('serviceWorkers: ' + e.message); } }
    if (opts.opfs !== false && navigator.storage && navigator.storage.getDirectory) {
      try {
        out.opfs = await readOPFS(await navigator.storage.getDirectory());
      } catch (e) {
        out.opfs = { error: String(e), files: [], dirs: [] };
      }
    }
    if (opts.buckets !== false && navigator.storageBuckets) {
      try {
        out.buckets = await readBuckets();
      } catch (e) {
        out.buckets = { error: String(e), buckets: [] };
      }
    }
    return out;
  }

  // payload: { ls, ss, idb, caches, sw, opfs, buckets }
  // opts: { mode: 'merge'|'replace', fetchScript irrelevant here }
  async function restoreSiteAll(payload, opts) {
    opts = opts || {};
    const mode = opts.mode === 'replace' ? 'replace' : 'merge';
    const out = { mode };
    if (payload.ls) out.localStorage = restoreLS(payload.ls, mode);
    if (payload.ss) out.sessionStorage = restoreSS(payload.ss, mode);
    if (payload.idb) out.indexedDB = await restoreIDB(payload.idb, { replace: mode === 'replace' });
    if (payload.sw && payload.sw.length) out.serviceWorkers = await restoreSW(payload.sw);
    if (payload.caches) out.cacheStorage = await restoreCacheStorage(caches, payload.caches, mode);
    if (payload.opfs) {
      const root = await navigator.storage.getDirectory();
      out.opfs = await restoreOPFS(root, payload.opfs, mode);
    }
    if (payload.buckets) out.buckets = await restoreBuckets(payload.buckets, mode);
    return out;
  }

  async function wipeSiteAll(opts) {
    opts = opts || {};
    const out = {};
    localStorage.clear();
    sessionStorage.clear();
    const dbs = await indexedDB.databases();
    for (const d of dbs) await idbDelete(indexedDB, d.name);
    for (const n of await caches.keys()) await caches.delete(n);
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const r of regs) await r.unregister();
    if (navigator.storage && navigator.storage.getDirectory) {
      try { out.opfs = await wipeOPFS(await navigator.storage.getDirectory()); } catch (e) { out.opfs = { error: String(e) }; }
    }
    if (navigator.storageBuckets) {
      try { out.buckets = await wipeBuckets(); } catch (e) { out.buckets = { error: String(e) }; }
    }
    return out;
  }

  // ---------- chunked transport ----------
  // The extension stores a JSON string on globalThis.__BBR_TX and pulls it in
  // chunks; responses through chrome.debugger stay small and ASCII-safe.
  function setTx(jsonStr) { globalThis.__BBR_TX = jsonStr; return jsonStr.length; }
  function txLen() { return (globalThis.__BBR_TX || '').length; }
  function txChunk(i, len) { return (globalThis.__BBR_TX || '').substr(i, len); }
  function clearTx() { delete globalThis.__BBR_TX; }
  function pushRx(chunk) {
    globalThis.__BBR_RX = (globalThis.__BBR_RX || '') + chunk;
    return (globalThis.__BBR_RX || '').length;
  }
  function takeRx() {
    const s = globalThis.__BBR_RX || '';
    delete globalThis.__BBR_RX;
    return JSON.parse(s);
  }

  globalThis.__BBR = {
    enc, dec, encKey, decKey, abToB64, b64ToAb, wtf16B64, b64Wtf16,
    hasLoneSurrogate, encStr, decStr,
    readIDB, probeAutoIncrementIn, readCacheStorage, restoreCacheStorage,
    readSWs, restoreSW, readOPFS, restoreOPFS, wipeOPFS,
    readBuckets, restoreBuckets, wipeBuckets, listBuckets,
    readLS, readSS, restoreLS, restoreSS, restoreIDB,
    readSiteAll, restoreSiteAll, wipeSiteAll,
    setTx, txLen, txChunk, clearTx, pushRx, takeRx,
  };
})();
