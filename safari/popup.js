// Popup logic for Censorly v6.2

const wordInput = document.getElementById('wordInput');
const addBtn = document.getElementById('addBtn');
const wordList = document.getElementById('wordList');
const wordCount = document.getElementById('wordCount');
const enabledToggle = document.getElementById('enabledToggle');
const statusBadge = document.getElementById('statusBadge');
const modeBtns = document.querySelectorAll('.mode-btn');
const modeHint = document.getElementById('modeHint');
const currentSiteName = document.getElementById('currentSiteName');
const excludeBtn = document.getElementById('excludeBtn');
const siteList = document.getElementById('siteList');

const MODE_HINTS = {
  hide: 'Word disappears completely — becomes invisible, nothing shows in its place.',
  censor: 'Classic redaction — solid dark boxes over each letter, like a blacked-out document.',
  blur: 'Word is blurred/pixelated. Hover over it to reveal.',
};

let state = {
  words: [],
  wildcardWords: [],
  enabled: true,
  mode: 'hide',
  excludedSites: [],
};

let currentHostname = '';

const DEFAULT_WORDS = [
  'shit', 'fuck', 'bitch', 'asshole', 'bastard', 'dickhead',
  'bullshit', 'damn', 'crap', 'piss', 'cunt', 'motherfucker',
  'dick', 'cock', 'pussy', 'prick', 'twat', 'wanker', 'slut',
  'whore', 'retard', 'faggot', 'nigger', 'nigga',
  'holy mole', 'holy moly', 'holy shit', 'holy crap',
];

async function loadState() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['words', 'wildcardWords', 'enabled', 'mode', 'excludedSites'], (result) => {
      state.words = result.words ?? DEFAULT_WORDS;
      state.wildcardWords = (result.wildcardWords ?? []).filter(word => state.words.includes(word));
      state.enabled = result.enabled ?? true;
      state.mode = result.mode ?? 'hide';
      state.excludedSites = result.excludedSites ?? [];
      resolve();
    });
  });
}

async function saveState() {
  return new Promise((resolve) => {
    chrome.storage.sync.set({
      words: state.words,
      wildcardWords: state.wildcardWords,
      enabled: state.enabled,
      mode: state.mode,
      excludedSites: state.excludedSites,
    }, () => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, {
            action: 'updateFilter',
            words: state.words,
            wildcardWords: state.wildcardWords,
            enabled: state.enabled,
            mode: state.mode,
            excludedSites: state.excludedSites,
          }).catch(() => {});
        }
      });
      resolve();
    });
  });
}

function renderWords() {
  wordList.innerHTML = '';
  wordCount.textContent = `${state.words.length} word${state.words.length !== 1 ? 's' : ''} in filter`;
  if (state.words.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No words yet. Add one above.';
    wordList.appendChild(empty);
    return;
  }
  state.words.forEach((word, index) => {
    const item = document.createElement('div');
    item.className = 'word-item';
    const wordSpan = document.createElement('span');
    wordSpan.className = 'word';
    wordSpan.textContent = word;
    const isWildcard = state.wildcardWords.includes(word);
    const matchBtn = document.createElement('button');
    matchBtn.className = `match-toggle${isWildcard ? ' wildcard' : ''}`;
    matchBtn.textContent = isWildcard ? 'Wildcard' : 'Exact';
    matchBtn.title = isWildcard
      ? `Wildcard: “${word}” also matches word endings`
      : `Exact: only “${word}” is matched`;
    matchBtn.setAttribute('aria-label', `${word}: ${isWildcard ? 'wildcard' : 'exact'} matching. Click to change.`);
    matchBtn.addEventListener('click', async () => {
      const wildcardIndex = state.wildcardWords.indexOf(word);
      if (wildcardIndex >= 0) state.wildcardWords.splice(wildcardIndex, 1);
      else state.wildcardWords.push(word);
      await saveState();
      renderWords();
    });
    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove';
    removeBtn.textContent = '×';
    removeBtn.setAttribute('aria-label', `Remove ${word}`);
    removeBtn.addEventListener('click', async () => {
      state.words.splice(index, 1);
      state.wildcardWords = state.wildcardWords.filter(item => item !== word);
      await saveState();
      renderWords();
    });
    item.appendChild(wordSpan);
    item.appendChild(matchBtn);
    item.appendChild(removeBtn);
    wordList.appendChild(item);
  });
}

function renderToggle() {
  if (state.enabled) {
    enabledToggle.classList.add('on');
    statusBadge.textContent = 'ON';
    statusBadge.classList.remove('off');
  } else {
    enabledToggle.classList.remove('on');
    statusBadge.textContent = 'OFF';
    statusBadge.classList.add('off');
  }
}

function renderMode() {
  modeBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.mode === state.mode));
  modeHint.textContent = MODE_HINTS[state.mode] || '';
}

function renderSites() {
  siteList.innerHTML = '';
  state.excludedSites.forEach((site, index) => {
    const item = document.createElement('div');
    item.className = 'site-item';
    const urlSpan = document.createElement('span');
    urlSpan.className = 'site-url';
    urlSpan.textContent = site;
    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove';
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', async () => {
      state.excludedSites.splice(index, 1);
      await saveState();
      renderSites();
      renderExcludeBtn();
    });
    item.appendChild(urlSpan);
    item.appendChild(removeBtn);
    siteList.appendChild(item);
  });
}

function renderExcludeBtn() {
  if (!currentHostname) { excludeBtn.disabled = true; currentSiteName.textContent = '—'; return; }
  currentSiteName.textContent = currentHostname;
  const isExcluded = state.excludedSites.includes(currentHostname);
  excludeBtn.textContent = isExcluded ? 'Remove' : 'Exclude';
  excludeBtn.classList.toggle('excluded', isExcluded);
}

async function addWord() {
  const word = wordInput.value.trim().toLowerCase();
  if (!word) return;
  if (state.words.includes(word)) { wordInput.value = ''; return; }
  state.words.push(word);
  wordInput.value = '';
  await saveState();
  renderWords();
}

addBtn.addEventListener('click', addWord);
wordInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addWord(); });

enabledToggle.addEventListener('click', async () => {
  state.enabled = !state.enabled;
  await saveState();
  renderToggle();
});

modeBtns.forEach(btn => {
  btn.addEventListener('click', async () => {
    state.mode = btn.dataset.mode;
    await saveState();
    renderMode();
  });
});

const refreshBtn = document.getElementById('refreshBtn');
refreshBtn.addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) chrome.tabs.reload(tabs[0].id);
  });
});

excludeBtn.addEventListener('click', async () => {
  if (!currentHostname) return;
  const idx = state.excludedSites.indexOf(currentHostname);
  if (idx >= 0) state.excludedSites.splice(idx, 1);
  else state.excludedSites.push(currentHostname);
  await saveState();
  renderSites();
  renderExcludeBtn();
});


// ─── Import / Export word list ─────────────────────────
const importFileInput = document.getElementById('importFile');
const exportBtn = document.getElementById('exportBtn');
const importToast = document.getElementById('importToast');

function showToast(msg) {
  if (!importToast) return;
  importToast.textContent = msg;
  importToast.classList.add('show');
  setTimeout(() => importToast.classList.remove('show'), 2500);
}

// Import: read a .txt or .csv file (one word per line or comma-separated)
if (importFileInput) {
  importFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target.result;
      // Split on newlines, commas, or semicolons
      const words = text.split(/[\r\n,;]+/)
        .map(w => w.trim().toLowerCase())
        .filter(w => w.length > 0 && !state.words.includes(w));
      if (words.length === 0) {
        showToast('No new words found in file');
        return;
      }
      state.words.push(...words);
      saveState().then(() => {
        renderWords();
        showToast(`Added ${words.length} word${words.length !== 1 ? 's' : ''}`);
      });
    };
    reader.readAsText(file);
    // Reset the input so the same file can be re-imported
    e.target.value = '';
  });
}

// Export: download current word list as a .txt file
if (exportBtn) {
  exportBtn.addEventListener('click', () => {
    if (state.words.length === 0) {
      showToast('No words to export');
      return;
    }
    const text = state.words.join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'censorly-words.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(`Exported ${state.words.length} word${state.words.length !== 1 ? 's' : ''}`);
  });
}


(async () => {
  await loadState();
  renderWords();
  renderToggle();
  renderMode();
  renderSites();

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0] && tabs[0].url) {
      try {
        currentHostname = new URL(tabs[0].url).hostname;
      } catch (e) {
        currentHostname = '';
      }
    }
    renderExcludeBtn();
  });

  wordInput.focus();
})();
