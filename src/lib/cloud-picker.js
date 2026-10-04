// Pure UI-state transitions for the GitHub repository/branch picker.
// Framework-free so the node test suite can cover them (dashboard modules
// import React and cannot run under plain node).

// Full reset applied when the token field is edited. Stale repo/branch
// selections made under the previous token must never be submitted without
// re-validation against the new token — a half-correct submenu (empty
// dropdowns but old values still in form state) is the riskiest failure.
export function tokenChangedTransition() {
  return {
    form: { owner: '', repo: '', branch: '' },
    cloud: {
      repoList: null,
      branchList: null,
      tokenValid: null,
      repoInfo: null,
      repoInfoError: null,
    },
  };
}

// Branch picker render mode. Three visually distinct states plus manual:
// - 'choose-repo-first': no repository selected yet → disabled dropdown
// - 'loading': repository selected, branches fetching → disabled dropdown
// - 'ready': branches loaded → enabled dropdown
// - 'manual': text input (manual repo entry, or branch fetch failed)
export function branchPickerMode({ branchList, repoSelected, repoManual }) {
  if (repoManual) return 'manual';
  if (!repoSelected) return 'choose-repo-first';
  if (!branchList || branchList.loading) return 'loading';
  return branchList.error || branchList.manual ? 'manual' : 'ready';
}

// Client-side repository filter for the picker search box. Repositories are
// already fully in memory (listRepositories paginates everything), so no
// API re-fetch per keystroke. Case-insensitive substring on full name.
export function filterRepos(repos, query) {
  if (!Array.isArray(repos)) return [];
  const q = String(query || '')
    .trim()
    .toLowerCase();
  if (!q) return repos;
  return repos.filter((r) =>
    String((r && r.fullName) || '')
      .toLowerCase()
      .includes(q)
  );
}

// A valid token that lists zero repositories is the signature of a
// fine-grained PAT scoped to specific repositories: GitHub may not list
// them via /user/repos even though push access works. Not a bug —
// the UI must say so and offer manual entry, not a silent empty list.
export function isEmptyRepoList(repos) {
  return Array.isArray(repos) && repos.length === 0;
}
