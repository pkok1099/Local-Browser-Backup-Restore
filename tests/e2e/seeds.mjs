// Bookmark seed/destroy/verify helpers for the E2E suite. All data flows
// through the real chrome.bookmarks API inside the extension page — the same
// API the collector and restore engine use.
export const BOOKMARK_SEED = [
  { title: 'E2E One', url: 'https://example.com/e2e-one' },
  { title: 'E2E Two', url: 'https://example.com/e2e-two' },
  { title: 'E2E Three', url: 'https://example.com/e2e-three' }
];

export const SEED_FOLDER = 'E2E-Roundtrip';

export async function seedBookmarks(page, folderTitle = SEED_FOLDER) {
  return page.evaluate(
    async ({ folderTitle, seeds }) => {
      const tree = await chrome.bookmarks.getTree();
      const bar = tree[0].children.find((n) => n.id === '1') || tree[0].children[0];
      const folder = await chrome.bookmarks.create({ parentId: bar.id, title: folderTitle });
      for (const s of seeds) {
        await chrome.bookmarks.create({ parentId: folder.id, title: s.title, url: s.url });
      }
      return folder.id;
    },
    { folderTitle, seeds: BOOKMARK_SEED }
  );
}

// Removes every bookmark folder with the given title (the "destroy the
// profile" step). Returns the number of folders removed.
export async function destroyBookmarks(page, folderTitle = SEED_FOLDER) {
  return page.evaluate(async (folderTitle) => {
    const found = await chrome.bookmarks.search({ title: folderTitle });
    let removed = 0;
    for (const n of found) {
      if (!n.url) {
        await chrome.bookmarks.removeTree(n.id);
        removed++;
      }
    }
    return removed;
  }, folderTitle);
}

// Returns the seeded folder's children as [{title, url}], or null when the
// folder does not exist.
export async function readSeededBookmarks(page, folderTitle = SEED_FOLDER) {
  return page.evaluate(async (folderTitle) => {
    const found = await chrome.bookmarks.search({ title: folderTitle });
    const folder = found.find((n) => !n.url);
    if (!folder) return null;
    const children = await chrome.bookmarks.getChildren(folder.id);
    return children.map((c) => ({ title: c.title, url: c.url }));
  }, folderTitle);
}
