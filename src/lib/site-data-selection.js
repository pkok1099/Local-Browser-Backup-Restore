export function filterSiteDataOrigins(origins, query) {
  const term = String(query || '')
    .trim()
    .toLocaleLowerCase();
  if (!term) return origins;
  return origins.filter(({ origin }) => origin.toLocaleLowerCase().includes(term));
}

export function getSelectedSiteDataOrigins(origins, includedOrigins) {
  if (includedOrigins === null || includedOrigins === undefined) return origins;
  const included = includedOrigins instanceof Set ? includedOrigins : new Set(includedOrigins);
  return origins.filter(({ origin }) => included.has(origin));
}
