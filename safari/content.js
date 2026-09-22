// Content script — Censorly v6.0

// ─── State ────────────────────────────────────────────────
let filterState = {
  words: [],
  wildcardWords: [],
  enabled: true,
  mode: 'hide',
  excludedSites: [],
};

// ─── Default cuss words ───────────────────────────────────
const DEFAULT_WORDS = [
  'shit', 'fuck', 'bitch', 'asshole', 'bastard', 'dickhead',
  'bullshit', 'damn', 'crap', 'piss', 'cunt', 'motherfucker',
  'dick', 'cock', 'pussy', 'prick', 'twat', 'wanker', 'slut',
  'whore', 'retard', 'faggot', 'nigger', 'nigga',
  'holy mole', 'holy moly', 'holy shit', 'holy crap',
];

// ─── Site exclusion check ─────────────────────────────────
function isSiteExcluded() {
  const hostname = location.hostname;
  return filterState.excludedSites.some(site => hostname === site || hostname.endsWith('.' + site));
}

// ─── Sensitive-page safeguard (v5.6) ─────────────────────
// Entirely client-side. No external lists, APIs, cloud services, telemetry,
// or network requests of any kind. Filtering automatically stays inactive on
// sensitive pages (banking, payment/checkout, credentials/login) and pauses
// safely if a page becomes sensitive after filtering has started.
//
// Detection is conservative and combines two independent signal groups:
//   (1) URL/hostname signals (host subdomains + path tokens)
//   (2) Sensitive form controls: password inputs and payment autocomplete
//       types (cc-number, cc-csc, cc-exp, transaction-* and one-time-code)
// No hardcoded finite list of bank brands is used.
let sensitiveActive = false;

const SENSITIVE_HOST_PATTERNS = [
  /(^|\.)secure\./i,
  /(^|\.)accounts?\./i,
  /(^|\.)login\./i,
  /(^|\.)signin\./i,
  /(^|\.)auth\./i,
  /(^|\.)sso\./i,
  /(^|\.)pay\./i,
  /(^|\.)payments\./i,
  /(^|\.)checkout\./i,
  /(^|\.)banking\./i,
  /(^|\.)wallet\./i,
];

const SENSITIVE_PATH_PATTERNS = [
  /\/login\b/i, /\/log-in\b/i, /\/signin\b/i, /\/sign-in\b/i,
  /\/account\b/i, /\/accounts\b/i, /\/auth\b/i, /\/authenticate\b/i,
  /\/oauth\b/i, /\/sso\b/i, /\/checkout\b/i, /\/payment\b/i,
  /\/payments\b/i, /\/pay\b/i, /\/billing\b/i, /\/banking\b/i,
  /\/wallet\b/i, /\/reset-password\b/i, /\/forgot-password\b/i,
  /\/two-factor\b/i, /\/2fa\b/i, /\/mfa\b/i, /\/otp\b/i,
  /\/verify\b/i, /\/credentials\b/i,
];

// Payment autocomplete tokens defined by the WHATWG autocomplete standard.
const SENSITIVE_AUTOCOMPLETE = new Set([
  'current-password', 'new-password', 'password', 'username',
  'cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year',
  'cc-name', 'cc-given-name', 'cc-family-name', 'cc-additional-name',
  'cc-type', 'cc-cid', 'transaction-amount', 'transaction-currency',
  'transaction-type', 'one-time-code',
]);

const SENSITIVE_INPUT_TYPES = new Set(['password']);

// Conservative name/id heuristics. We only treat a field as sensitive when the
// token clearly denotes a credential or payment value, to avoid false
// positives on ordinary comment/search fields.
const SENSITIVE_NAME_TOKENS = /\b(password|passwd|pwd|cvv|cvc|csc|cardnumber|cardno|ccnumber|ccno|ccnum|otp|pincode)\b/i;

function urlLooksSensitive() {
  try {
    const hostname = location.hostname || '';
    if (hostname && SENSITIVE_HOST_PATTERNS.some(re => re.test(hostname))) return true;
    const path = (location.pathname || '') + (location.search || '');
    if (path && SENSITIVE_PATH_PATTERNS.some(re => re.test(path))) return true;
  } catch (e) { /* location may be unavailable in some sandboxed frames */ }
  return false;
}

function hasSensitiveFormControls(root) {
  try {
    const scope = root && root.nodeType === Node.ELEMENT_NODE ? root : document;
    if (!scope.querySelectorAll) return false;
    const inputs = scope.querySelectorAll('input, select, textarea');
    for (const el of inputs) {
      if (el.tagName !== 'INPUT') continue;
      const type = (el.type || '').toLowerCase();
      if (SENSITIVE_INPUT_TYPES.has(type)) return true;
      const ac = (el.getAttribute('autocomplete') || '').toLowerCase().trim();
      if (ac) {
        const tokens = ac.split(/\s+/);
        for (const token of tokens) {
          if (SENSITIVE_AUTOCOMPLETE.has(token)) return true;
          if (token.indexOf('transaction-') === 0) return true;
        }
      }
      const nm = ((el.name || '') + ' ' + (el.id || '')).toLowerCase();
      if (SENSITIVE_NAME_TOKENS.test(nm)) return true;
    }
    const forms = scope.querySelectorAll('form');
    for (const form of forms) {
      const ac = (form.getAttribute('autocomplete') || '').toLowerCase();
      if (ac && /current-password|new-password|cc-number|transaction-|one-time-code/.test(ac)) return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

function detectSensitivePage() {
  if (urlLooksSensitive()) return true;
  if (document.body && hasSensitiveFormControls(document)) return true;
  return false;
}

let sensitivityRecheckScheduled = false;
function scheduleSensitivityRecheck() {
  if (sensitivityRecheckScheduled) return;
  sensitivityRecheckScheduled = true;
  queueMicrotask(recheckSensitivity);
}

// Re-evaluate sensitivity. When a page becomes sensitive after filtering has
// started, stop observation/filtering and restore the original text/DOM by
// unwrapping only Censorly-owned cs-* spans (never using innerHTML). This is a
// one-way pause for the lifetime of this document: once paused, we do not
// resume filtering on the same page even if the sensitive signals disappear,
// which avoids flicker on single-page-app navigations.
function recheckSensitivity() {
  sensitivityRecheckScheduled = false;
  const nowSensitive = detectSensitivePage();
  if (nowSensitive && !sensitiveActive) {
    sensitiveActive = true;
    restoreAll();
    stopObserver();
  }
}

// ─── Check if element is one of our filter spans ──────────
function isFilterSpan(el) {
  if (!el || !el.classList) return false;
  return el.classList.contains('cs-hide') || el.classList.contains('cs-censor') || el.classList.contains('cs-blur');
}

// ─── Inject CSS for filtered spans ───────────────────────
// Hide  = word visually disappears (transparent, blank space left behind)
// Censor = classic redaction — solid dark boxes over each letter
// Blur  = pixelated blur, hover to reveal
const csStyle = document.createElement('style');
csStyle.id = 'cs-filter-styles';
csStyle.textContent = `
  .cs-hide {
    color: transparent !important;
    background: transparent !important;
    -webkit-text-fill-color: transparent !important;
    text-shadow: none !important;
    user-select: text !important;
    -webkit-user-select: text !important;
  }
  .cs-hide::selection { color: transparent !important; background: transparent !important; -webkit-text-fill-color: transparent !important; }
  .cs-hide::-moz-selection { color: transparent !important; background: transparent !important; }

  .cs-censor {
    background: #1a1a1a !important;
    color: #1a1a1a !important;
    -webkit-text-fill-color: #1a1a1a !important;
    text-shadow: none !important;
    border-radius: 3px;
    margin: 0 1px;
    padding: 0 2px;
    box-shadow: 0 0 0 1px rgba(128,128,128,0.4) !important;
    user-select: text !important;
    -webkit-user-select: text !important;
  }
  .cs-censor::selection { background: #1a1a1a !important; color: #1a1a1a !important; -webkit-text-fill-color: #1a1a1a !important; }
  .cs-censor::-moz-selection { background: #1a1a1a !important; color: #1a1a1a !important; }

  .cs-blur {
    filter: blur(5px);
    transition: filter 0.2s;
    cursor: pointer;
    user-select: text !important;
    -webkit-user-select: text !important;
  }
  .cs-blur:hover, .cs-blur:active {
    filter: none !important;
  }
`;
(document.head || document.documentElement).appendChild(csStyle);

// ─── Interactive element detection ───────────────────────
function isInteractiveContainer(el) {
  if (!el || !el.closest) return false;
  const editable = el.closest('[contenteditable="true"]');
  if (editable && document.activeElement === editable) return true;
  return false;
}

// ─── Accent-insensitive matching ──────────────────────────
const ACCENTED_RANGE = /[\u00C0-\u017F]/;
function stripDiacriticsChar(ch) {
  if (!ACCENTED_RANGE.test(ch)) return ch;
  const decomposed = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return decomposed.length >= 1 ? decomposed[0] : ch;
}
function stripDiacritics(text) {
  let out = '';
  for (const ch of text) out += stripDiacriticsChar(ch);
  return out;
}

// ─── Input/Textarea/Contenteditable Censoring ────────────
// Maps are intentionally iterable: restore and form-submit paths must be able
// to restore every modified field before clearing tracked originals.
const originalInputValues = new Map();
const originalEditableSnapshots = new Map();
function snapshotEditable(el) {
  return Array.from(el.childNodes, node => node.cloneNode(true));
}
function restoreEditableSnapshot(el, snapshot) {
  el.replaceChildren(...snapshot.map(node => node.cloneNode(true)));
}
const INPUT_SELECTOR = 'input[type="text"], input[type="search"], input[type="url"], input[type="email"], input[type="tel"], input:not([type]), textarea';

function queryWithin(root, selector) {
  const scope = root && root.nodeType === Node.ELEMENT_NODE ? root : document;
  const results = [];
  if (scope.matches && scope.matches(selector)) results.push(scope);
  if (scope.querySelectorAll) results.push(...scope.querySelectorAll(selector));
  return results;
}

function censorInputFields(root = document) {
  if (!isFilteringActive()) return;

  queryWithin(root, INPUT_SELECTOR).forEach(input => {
    if (document.activeElement === input) return;
    const value = input.value;
    if (!value || !value.trim()) return;

    const matches = findMatches(stripDiacritics(value), combinedMatcher);
    if (matches.length === 0) return;

    let censored = value;
    for (let i = matches.length - 1; i >= 0; i--) {
      const match = matches[i];
      censored = censored.slice(0, match.start) + '\u2588'.repeat(match.end - match.start) + censored.slice(match.end);
    }

    if (!originalInputValues.has(input)) originalInputValues.set(input, value);
    input.value = censored;
    input.dataset.csInputCensored = 'true';
  });

  queryWithin(root, '[contenteditable="true"]').forEach(el => {
    if (document.activeElement === el || el.dataset.csFiltered === 'true') return;
    const text = el.textContent;
    if (!text || text.trim().length < 2) return;
    if (findMatches(stripDiacritics(text), combinedMatcher).length === 0) return;

    if (!originalEditableSnapshots.has(el)) originalEditableSnapshots.set(el, snapshotEditable(el));
    filterCrossNodePhrases(el);
    filterAllText(el);
    el.dataset.csFiltered = 'true';
  });
}

document.addEventListener('focus', (e) => {
  if (e.target.matches && e.target.matches(INPUT_SELECTOR)) {
    const orig = originalInputValues.get(e.target);
    if (orig !== undefined) {
      e.target.value = orig;
      delete e.target.dataset.csInputCensored;
    }
  }
  if (e.target.isContentEditable) {
    const orig = originalEditableSnapshots.get(e.target);
    if (orig !== undefined) {
      restoreEditableSnapshot(e.target, orig);
      e.target.removeAttribute('data-cs-filtered');
    }
  }
}, true);

document.addEventListener('blur', (e) => {
  if (e.target.matches && e.target.matches(INPUT_SELECTOR)) {
    originalInputValues.set(e.target, e.target.value);
    setTimeout(() => censorInputFields(), 50);
  }
  if (e.target.isContentEditable) {
    originalEditableSnapshots.set(e.target, snapshotEditable(e.target));
    setTimeout(() => {
      e.target.removeAttribute('data-cs-filtered');
      filterAllText(e.target);
      e.target.dataset.csFiltered = 'true';
    }, 50);
  }
}, true);

document.addEventListener('submit', (e) => {
  originalInputValues.forEach((original, input) => {
    if (input.form === e.target) input.value = original;
  });
  originalEditableSnapshots.forEach((original, el) => {
    if (el.closest('form') === e.target) restoreEditableSnapshot(el, original);
  });
}, true);

// ─── Fast matching and mutation-scoped filtering ─────────
let combinedMatcher = null;
let combinedPhraseMatcher = null;
let observer = null;
let flushScheduled = false;
let initialBodyProcessed = false;
const pendingRoots = new Set();

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'NOSCRIPT', 'SELECT', 'OPTION']);
const CROSS_NODE_SELECTOR = 'p,li,blockquote,figcaption,caption,td,th,h1,h2,h3,h4,h5,h6,label,button,a,summary,dt,dd,div';

function buildCombinedRegex(words) {
  const parts = words
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map(word => {
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const flexible = escaped.replace(/ /g, '[\\s\\-_]+');
      const ending = filterState.wildcardWords.includes(word) ? '[\\p{L}\\p{N}_]*' : '';
      return `${flexible}${ending}`;
    });
  return parts.length ? new RegExp(`\\b(?:${parts.join('|')})\\b`, 'giu') : null;
}

function rebuildMatchers() {
  combinedMatcher = buildCombinedRegex(filterState.words);
  combinedPhraseMatcher = buildCombinedRegex(filterState.words.filter(word => word.includes(' ')));
}

function findMatches(text, regex) {
  if (!regex || !text) return [];
  regex.lastIndex = 0;
  const raw = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    raw.push({ start: match.index, end: match.index + match[0].length });
    if (match[0].length === 0) regex.lastIndex++;
  }
  regex.lastIndex = 0;
  raw.sort((a, b) => a.start - b.start || b.end - a.end);

  const merged = [];
  for (const item of raw) {
    const previous = merged[merged.length - 1];
    if (!previous || item.start >= previous.end) merged.push(item);
  }
  return merged;
}

function isFilteringActive() {
  return filterState.enabled && filterState.words.length > 0 && !isSiteExcluded() && !sensitiveActive;
}

function runFilter() {
  if (!isFilteringActive()) {
    restoreAll();
    stopObserver();
    return;
  }
  rebuildMatchers();
  if (document.body) processRoot(document.body);
  startObserver();
}

function processRoot(root) {
  if (!root || !root.isConnected || !isFilteringActive()) return;
  const target = root.nodeType === Node.TEXT_NODE ? root.parentElement : root;
  if (!target || isFilterSpan(target) || target.closest?.('.cs-hide, .cs-censor, .cs-blur')) return;
  if (target === document.body) initialBodyProcessed = true;
  filterCrossNodePhrases(target);
  filterAllText(target);
  censorInputFields(target);
}

function filterAllText(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      if (parent.closest?.('.cs-hide, .cs-censor, .cs-blur')) return NodeFilter.FILTER_REJECT;
      if (parent.closest?.('[contenteditable="true"]') && !root.matches?.('[contenteditable="true"]')) return NodeFilter.FILTER_REJECT;
      if (isInteractiveContainer(parent)) return NodeFilter.FILTER_REJECT;
      return node.nodeValue && node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });
  const textNodes = [];
  let node;
  while ((node = walker.nextNode())) textNodes.push(node);
  textNodes.forEach(filterTextNode);
}

function filterTextNode(textNode) {
  const text = textNode.nodeValue;
  if (!text || !text.trim() || !textNode.parentElement || isFilterSpan(textNode.parentElement)) return;
  const matches = findMatches(stripDiacritics(text), combinedMatcher);
  if (matches.length === 0) return;

  const fragment = document.createDocumentFragment();
  const modeClass = `cs-${filterState.mode}`;
  let cursor = 0;
  for (const match of matches) {
    if (match.start > cursor) fragment.appendChild(document.createTextNode(text.slice(cursor, match.start)));
    const span = document.createElement('span');
    span.className = modeClass;
    span.textContent = text.slice(match.start, match.end);
    fragment.appendChild(span);
    cursor = match.end;
  }
  if (cursor < text.length) fragment.appendChild(document.createTextNode(text.slice(cursor)));
  textNode.parentElement.replaceChild(fragment, textNode);
}

// Surgical cross-node matching: each overlapping slice is wrapped in place,
// preserving all original inline elements and avoiding innerHTML replacement.
function filterCrossNodePhrases(root) {
  if (!combinedPhraseMatcher || !root.querySelectorAll) return;
  const candidates = [];
  if (root.matches?.(CROSS_NODE_SELECTOR)) candidates.push(root);
  candidates.push(...root.querySelectorAll(CROSS_NODE_SELECTOR));

  for (const container of candidates) {
    if (!container.isConnected || container.closest?.('.cs-hide, .cs-censor, .cs-blur')) continue;
    if (container.closest?.('[contenteditable="true"]') && !container.matches('[contenteditable="true"]')) continue;
    if (container.querySelector(`:scope > ${CROSS_NODE_SELECTOR.split(',').join(', :scope > ')}`)) continue;
    filterCrossNodeContainer(container);
  }
}

function filterCrossNodeContainer(container) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      if (parent.closest?.('.cs-hide, .cs-censor, .cs-blur')) return NodeFilter.FILTER_REJECT;
      return node.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });

  const entries = [];
  let fullText = '';
  let node;
  while ((node = walker.nextNode())) {
    const start = fullText.length;
    fullText += node.nodeValue;
    entries.push({ node, start, end: fullText.length });
  }
  if (entries.length < 2 || !fullText.trim()) return;

  const matches = findMatches(stripDiacritics(fullText), combinedPhraseMatcher);
  for (let mi = matches.length - 1; mi >= 0; mi--) {
    const match = matches[mi];
    for (let ei = entries.length - 1; ei >= 0; ei--) {
      const entry = entries[ei];
      const overlapStart = Math.max(match.start, entry.start);
      const overlapEnd = Math.min(match.end, entry.end);
      if (overlapStart < overlapEnd && entry.node.isConnected) {
        const localStart = overlapStart - entry.start;
        const localEnd = overlapEnd - entry.start;
        if (entry.node.nodeValue.slice(localStart, localEnd).trim()) {
          wrapTextSlice(entry.node, localStart, localEnd);
        }
      }
    }
  }
}

function wrapTextSlice(textNode, start, end) {
  if (start < 0 || end <= start || end > textNode.nodeValue.length) return;
  let matched = textNode;
  if (start > 0) matched = textNode.splitText(start);
  const length = end - start;
  if (length < matched.nodeValue.length) matched.splitText(length);
  const span = document.createElement('span');
  span.className = `cs-${filterState.mode}`;
  span.textContent = matched.nodeValue;
  matched.parentElement.replaceChild(span, matched);
}

function restoreAll() {
  document.querySelectorAll('.cs-hide, .cs-censor, .cs-blur').forEach(span => {
    if (span.parentElement) span.replaceWith(document.createTextNode(span.textContent));
  });
  document.querySelectorAll('[data-cs-filtered]').forEach(el => delete el.dataset.csFiltered);
  originalInputValues.forEach((original, input) => { if (input.isConnected) input.value = original; });
  originalInputValues.clear();
  originalEditableSnapshots.forEach((original, el) => { if (el.isConnected) restoreEditableSnapshot(el, original); });
  originalEditableSnapshots.clear();
}

function applyModeInstantly() {
  const modeClass = `cs-${filterState.mode}`;
  document.querySelectorAll('.cs-hide, .cs-censor, .cs-blur').forEach(span => { span.className = modeClass; });
}

function queueRoot(node) {
  if (!node || !isFilteringActive()) return;
  let element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  if (!element || !element.isConnected || isFilterSpan(element) || element.closest?.('.cs-hide, .cs-censor, .cs-blur')) return;
  element = element.closest?.(CROSS_NODE_SELECTOR) || element;
  pendingRoots.add(element);
  if (!flushScheduled) {
    flushScheduled = true;
    queueMicrotask(flushPendingRoots);
  }
}

function flushPendingRoots() {
  flushScheduled = false;
  if (!isFilteringActive() || pendingRoots.size === 0) { pendingRoots.clear(); return; }
  const roots = [...pendingRoots].filter(root => root.isConnected);
  pendingRoots.clear();
  const minimalRoots = roots.filter((root, index) => !roots.some((other, otherIndex) => otherIndex !== index && other.contains(root)));

  observer?.disconnect();
  try {
    minimalRoots.forEach(processRoot);
  } finally {
    startObserver();
  }
}

function startObserver() {
  if (!document.documentElement || !isFilteringActive()) return;
  if (!observer) {
    observer = new MutationObserver(records => {
      let addedElements = false;
      for (const record of records) {
        if (record.type === 'characterData') {
          queueRoot(record.target);
        } else {
          record.addedNodes.forEach(node => {
            queueRoot(node);
            if (node.nodeType === Node.ELEMENT_NODE) addedElements = true;
          });
        }
      }
      if (addedElements) scheduleSensitivityRecheck();
    });
  }
  observer.disconnect();
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
}

function stopObserver() {
  observer?.disconnect();
  pendingRoots.clear();
  flushScheduled = false;
}

function arraysEqual(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

// ─── Message listener ─────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'getStatus') {
    sendResponse({ sensitive: sensitiveActive, active: isFilteringActive() });
    return true;
  }
  if (msg.action === 'updateFilter') {
    recheckSensitivity();
    const previous = {
      words: [...filterState.words],
      wildcardWords: [...filterState.wildcardWords],
      enabled: filterState.enabled,
      mode: filterState.mode,
      excludedSites: [...filterState.excludedSites],
    };
    const wasActive = isFilteringActive();

    filterState.words = msg.words ?? filterState.words;
    filterState.wildcardWords = msg.wildcardWords ?? filterState.wildcardWords;
    filterState.enabled = msg.enabled ?? filterState.enabled;
    filterState.mode = msg.mode ?? filterState.mode;
    filterState.excludedSites = msg.excludedSites ?? filterState.excludedSites;
    rebuildMatchers();

    const isActive = isFilteringActive();
    const onlyModeChanged = wasActive && isActive
      && arraysEqual(previous.words, filterState.words)
      && arraysEqual(previous.wildcardWords, filterState.wildcardWords)
      && arraysEqual(previous.excludedSites, filterState.excludedSites)
      && previous.enabled === filterState.enabled
      && previous.mode !== filterState.mode;

    stopObserver();
    if (onlyModeChanged) {
      applyModeInstantly();
      startObserver();
    } else if (!isActive) {
      restoreAll();
    } else {
      restoreAll();
      if (document.body) processRoot(document.body);
      startObserver();
    }
    sendResponse({ ok: true });
  }
  return true;
});

// ─── Init at document_start ───────────────────────────────
chrome.storage.sync.get(['words', 'wildcardWords', 'enabled', 'mode', 'excludedSites'], result => {
  filterState.words = result.words ?? DEFAULT_WORDS;
  filterState.wildcardWords = (result.wildcardWords ?? []).filter(word => filterState.words.includes(word));
  filterState.enabled = result.enabled ?? true;
  filterState.mode = result.mode ?? 'hide';
  filterState.excludedSites = result.excludedSites ?? [];
  rebuildMatchers();
  recheckSensitivity();

  if (!isFilteringActive()) return;
  if (document.body) {
    runFilter();
  } else {
    startObserver();
    document.addEventListener('DOMContentLoaded', () => {
      recheckSensitivity();
      if (isFilteringActive() && document.body && !initialBodyProcessed) {
        observer?.disconnect();
        processRoot(document.body);
        startObserver();
      }
    }, { once: true });
  }
});
