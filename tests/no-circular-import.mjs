// Detects circular imports among the core site-data/backup modules.
// A cycle can cause "Cannot access before initialization" (TDZ) when a
// module-level let/const is accessed during another module's evaluation.
// This test builds the import graph from source and fails if a cycle exists.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
import { readdirSync, statSync } from 'node:fs';
function findModules(dir, base = '') {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const rel = base ? base + '/' + e : e;
    if (statSync(p).isDirectory()) {
      if (e === 'node_modules' || e === 'components' || e === 'entrypoints') continue;
      out.push(...findModules(p, rel));
    } else if (/\.(js|ts)$/.test(e) && !e.endsWith('.d.ts')) {
      out.push(rel);
    }
  }
  return out;
}
const modules = findModules(root);

function resolveImport(from, spec) {
  if (!spec.startsWith('.') && !spec.startsWith('@/')) return null;
  const base = spec.startsWith('@/')
    ? join(root, spec.slice(2))
    : join(dirname(join(root, from)), spec);
  // Try exact, then with extensions
  for (const cand of [base, base + '.js', base + '.ts']) {
    try {
      readFileSync(cand);
      // Normalize to relative path from src
      const rel = cand.slice(root.length + 1).replace(/\\/g, '/');
      if (modules.includes(rel)) return rel;
    } catch { /* not found */ }
  }
  return null;
}

const graph = new Map();
for (const mod of modules) {
  const src = readFileSync(join(root, mod), 'utf8');
  const deps = new Set();
  const re = /^import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm;
  let m;
  while ((m = re.exec(src)) !== null) {
    const resolved = resolveImport(mod, m[1]);
    if (resolved && resolved !== mod) deps.add(resolved);
  }
  graph.set(mod, [...deps]);
}

// DFS for cycles
const visited = new Set();
const stack = [];
let cycle = null;

function dfs(node) {
  if (stack.includes(node)) {
    cycle = [...stack.slice(stack.indexOf(node)), node];
    return true;
  }
  if (visited.has(node)) return false;
  visited.add(node);
  stack.push(node);
  for (const dep of graph.get(node) || []) {
    if (dfs(dep)) return true;
  }
  stack.pop();
  return false;
}

for (const mod of modules) {
  if (dfs(mod)) break;
}

if (cycle) {
  console.error('FAIL: circular import detected:');
  console.error('  ' + cycle.join(' -> '));
  process.exit(1);
} else {
  console.log(`PASS: no circular imports among ${modules.length} core modules`);
}
