import { hasCompressionStream } from './util.js';
import { createSiteLogger } from './site-log.js';

const has = (namespace) =>
  typeof chrome !== 'undefined' && chrome[namespace] !== undefined && chrome[namespace] !== null;
const probeLogger = createSiteLogger({ crawlId: 'capability-probes' });

function errorMessage(error) {
  return error && error.message ? error.message : String(error);
}

function createFailureReporter(onError) {
  let failureCount = 0;
  const report = (name, error) => {
    failureCount++;
    const message = `capability probe ${name} failed: ${errorMessage(error)}`;
    const context = { probe: name, error: errorMessage(error) };
    if (typeof onError === 'function') {
      try {
        onError('ERROR', 'SYSTEM', message, context);
        return;
      } catch (loggingError) {
        /* fall through to the persistent logger */
      }
    }
    probeLogger.log('ERROR', 'SYSTEM', message, context);
  };
  report.count = () => failureCount;
  return report;
}

async function probeCategory(name, isAvailable, probe, results, reportFailure) {
  try {
    if (!isAvailable()) return;
    await probe(results, reportFailure);
  } catch (error) {
    reportFailure(name, error);
    results[`${name}Error`] = errorMessage(error);
  }
}

async function probeBookmarkDateAdded(results, reportFailure) {
  let accepted;
  let folderId = null;
  let bookmarkId = null;
  try {
    const folder = await chrome.bookmarks.create({ parentId: '2', title: '__bbr_probe_' + Date.now() });
    folderId = folder.id;
    const fakeDate = 1000;
    const bookmark = await chrome.bookmarks.create({
      parentId: folderId,
      title: 'probe',
      url: 'https://bbr-probe.example/',
      dateAdded: fakeDate,
    });
    bookmarkId = bookmark.id;
    accepted = bookmark.dateAdded === fakeDate;
  } catch (error) {
    accepted = 'throws: ' + (error.message || 'error');
    reportFailure('bookmarks', error);
  } finally {
    try {
      if (folderId) await chrome.bookmarks.removeTree(folderId);
    } catch (error) {
      /* best-effort cleanup */
    }
    try {
      if (bookmarkId) await chrome.bookmarks.remove(bookmarkId);
    } catch (error) {
      /* best-effort cleanup */
    }
  }
  results.bookmarksCreateHonorsDateAdded = accepted;
}

async function probeHistory(results, reportFailure) {
  results.historyWriteApis = {
    addUrl: typeof chrome.history.addUrl,
    addVisit: typeof chrome.history.addVisit,
    createDetails: typeof chrome.history.createDetails,
    knownMethods: Object.keys(chrome.history).sort(),
  };
  if (typeof chrome.history.addUrl !== 'function') return;

  let addUrlResult;
  const probeUrl = 'https://bbr-probe.example/bbr-history-probe';
  try {
    await chrome.history.addUrl({ url: probeUrl });
    const found = await chrome.history.search({ text: 'bbr-history-probe', startTime: 0, maxResults: 10 });
    const hit = found.find((item) => item.url === probeUrl);
    const visits = hit ? await chrome.history.getVisits({ url: probeUrl }) : [];
    addUrlResult = {
      works: !!hit,
      visitCount: hit ? hit.visitCount : null,
      title: hit ? hit.title : null,
      lastVisitTimeSet: hit ? hit.lastVisitTime : null,
      transition: visits[0] ? visits[0].transition : null,
    };
    if (!hit) reportFailure('history.addUrl', new Error('probe URL was not found after addUrl'));
  } catch (error) {
    addUrlResult = { works: false, error: error.message || String(error) };
    reportFailure('history.addUrl', error);
  } finally {
    try {
      await chrome.history.deleteUrl({ url: probeUrl });
    } catch (error) {
      /* best-effort cleanup */
    }
  }
  results.historyAddUrl = addUrlResult;
}

function probeReadingListApiSurface(results) {
  results.readingListApi = Object.keys(chrome.readingList).sort();
}

async function removePartitionedProbeCookie() {
  try {
    await chrome.cookies.remove({
      name: '__bbr_probe',
      url: 'https://bbr-probe.example/',
      partitionKey: { topLevelSite: 'https://bbr-probe.example/' },
    });
  } catch (error) {
    /* best-effort cleanup */
  }
}

async function probeCookiePartitionKey(results, reportFailure) {
  let partitioned;
  try {
    const details = {
      url: 'https://bbr-probe.example/',
      name: '__bbr_probe',
      value: '1',
      secure: true,
      partitionKey: { topLevelSite: 'https://bbr-probe.example/' },
    };
    const cookie = await chrome.cookies.set(details);
    if (cookie) {
      partitioned = { works: true, partitionKeyEcho: cookie.partitionKey ?? null };
      await removePartitionedProbeCookie();
    } else {
      const fallback = await chrome.cookies.set({
        url: 'https://bbr-probe.example/',
        name: '__bbr_probe',
        value: '1',
        secure: true,
        partitionKey: { topLevelSite: 'https://bbr-probe.example/', hasCrossSiteAncestor: false },
      });
      if (fallback) {
        partitioned = {
          works: true,
          variant: 'hasCrossSiteAncestor:false',
          partitionKeyEcho: fallback.partitionKey ?? null,
        };
        await removePartitionedProbeCookie();
      } else {
        partitioned = {
          works: false,
          error: 'cookies.set resolved null (browser refused a partitioned cookie via the extension API)',
        };
      }
    }
  } catch (error) {
    partitioned = { works: false, error: error.message || String(error) };
  }
  if (!partitioned.works) reportFailure('cookies.partitionKey', new Error(partitioned.error));
  results.cookiesPartitionKey = partitioned;
}

async function probeCookieFirstPartyDomain(results, reportFailure) {
  try {
    const cookie = await chrome.cookies.set({
      url: 'https://bbr-probe.example/',
      name: '__bbr_plain',
      value: 'x',
    });
    results.cookiesFirstPartyDomainField = cookie && 'firstPartyDomain' in cookie;
    try {
      await chrome.cookies.remove({ url: 'https://bbr-probe.example/', name: '__bbr_plain' });
    } catch (error) {
      /* best-effort cleanup */
    }
    if (!results.cookiesFirstPartyDomainField) {
      reportFailure('cookies.firstPartyDomain', new Error('cookie response omitted firstPartyDomain'));
    }
  } catch (error) {
    results.cookiesFirstPartyDomainField = 'error';
    reportFailure('cookies.firstPartyDomain', error);
  }
}

async function probeCookies(results, reportFailure) {
  await probeCookiePartitionKey(results, reportFailure);
  await probeCookieFirstPartyDomain(results, reportFailure);
}

async function probeReadingListRoundTrip(results, reportFailure) {
  let result = null;
  const urls = [];
  try {
    const url = 'https://bbr-probe.example/article-' + Date.now();
    urls.push(url);
    const fakeTime = 1000;
    try {
      await chrome.readingList.addEntry({
        url,
        title: 'probe',
        hasBeenRead: false,
        creationTime: fakeTime,
        lastUpdateTime: fakeTime,
      });
    } catch (error) {
      await chrome.readingList.addEntry({ url, title: 'probe', hasBeenRead: false });
    }
    const list = await chrome.readingList.getEntries({});
    const found = list.find((item) => item.url === url);
    if (found) result = { creationTimeHonored: found.creationTime === fakeTime, fields: Object.keys(found).sort() };
    else reportFailure('readingList.roundTrip', new Error('probe entry was not returned by getEntries'));
  } catch (error) {
    result = 'error: ' + (error.message || 'unknown');
    reportFailure('readingList.roundTrip', error);
  } finally {
    for (const url of urls) {
      try {
        await chrome.readingList.removeEntry({ url });
      } catch (error) {
        /* best-effort cleanup */
      }
    }
  }
  results.readingList = result;
}

function probeCompression(results) {
  results.compressionStream = hasCompressionStream();
}

function probePrivateApis(results) {
  results.privateApisPresent = {
    settingsPrivate: has('settingsPrivate'),
    developerPrivate: has('developerPrivate'),
    enterprisePlatformKeysPrivate: has('enterprise.platformKeysPrivate'),
    contentSettings: has('contentSettings'),
    browsingData: has('browsingData'),
  };
}

function probeSessions(results) {
  results.sessionsMaxResults = chrome.sessions.MAX_SESSION_RESULTS || null;
}

export async function runCapabilityProbes({ onError } = {}) {
  const results = {};
  const reportFailure = createFailureReporter(onError);
  const categories = [
    ['bookmarks', () => has('bookmarks'), probeBookmarkDateAdded],
    ['history', () => has('history'), probeHistory],
    ['readingListApi', () => has('readingList'), probeReadingListApiSurface],
    ['cookies', () => has('cookies'), probeCookies],
    [
      'readingList',
      () => has('readingList') && typeof chrome.readingList.getEntries === 'function',
      probeReadingListRoundTrip,
    ],
    ['compressionStream', () => true, probeCompression],
    ['privateApis', () => true, probePrivateApis],
    ['sessions', () => has('sessions'), probeSessions],
  ];
  for (const [name, isAvailable, probe] of categories) {
    await probeCategory(name, isAvailable, probe, results, reportFailure);
  }
  if (reportFailure.count() && typeof onError !== 'function') await probeLogger.flush();
  return results;
}
