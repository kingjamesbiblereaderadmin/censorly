// Twitter/X editor-safety tests (jsdom harness).
// Reproduces the v6.3 gap: the @-mention typeahead, emoji menus and combobox
// search render OUTSIDE the contenteditable, in React-managed portals. Their
// suggestion text must never be wrapped in cs-* spans (that broke React
// reconciliation, so clicking a mention stopped filling the composer).
// Feed/read-only text must still filter normally.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const src = fs.readFileSync(path.join(__dirname, '..', 'chrome', 'content.js'), 'utf8');

const HTML = `<!DOCTYPE html><html><head></head><body>
  <!-- Feed content: MUST still be filtered -->
  <article id="feed"><p id="feed-text">this shit timeline post</p></article>

  <!-- X-style composer -->
  <div id="compose-widget" aria-labelledby="Tweet text">
    <label>
      <div id="compose" data-testid="tweetTextarea_0" role="textbox" contenteditable="true">
        <div data-testid="textlabel_container"><div><span data-text="true">hello @</span></div></div>
      </div>
    </label>
  </div>

  <!-- @-mention typeahead portal: OUTSIDE the contenteditable -->
  <div id="mention-portal" data-testid="typeaheadDropdown-0">
    <ul id="mention-list" role="listbox" aria-label="Suggestions">
      <li id="mention-opt-1" role="option" data-testid="typeaheadItem-0">
        <div><div><span>Dick Grayson</span></div><div><span>@dick_grayson</span></div></div>
      </li>
      <li id="mention-opt-2" role="option">
        <div><div><span>SlutWalk Organiser</span></div><div><span>@organiser</span></div></div>
      </li>
    </ul>
  </div>

  <!-- Emoji/category menu popup -->
  <div id="emoji-menu" role="menu">
    <div id="emoji-item" role="menuitem"><span>Damn Sticker Pack</span></div>
  </div>

  <!-- Search combobox: input + popup listbox inside role=combobox -->
  <div id="search-combo" role="combbox-typo" >
    <input type="text" id="search-input" value="damn query">
  </div>
</body></html>`;

function buildDom() {
  const dom = new JSDOM(HTML.replace('role="combbox-typo"', 'role="combobox"'), {
    runScripts: 'dangerously',
    url: 'https://twitter.com/home',
  });
  const w = dom.window;
  w.chrome = {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage() {},
    },
    storage: { sync: { get(defs, cb) { cb({}); } } },
  };
  const script = w.document.createElement('script');
  script.textContent = src;
  w.document.body.appendChild(script);
  return dom;
}

let failures = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + (extra || '')}`);
  if (!ok) failures++;
}

(async () => {
  const dom = buildDom();
  const w = dom.window;
  const doc = w.document;
  await new Promise(r => setTimeout(r, 300));

  const SPAN = '.cs-hide, .cs-censor, .cs-blur';

  // Feed text is filtered
  check('feed text still filtered', !!doc.querySelector('#feed-text ' + '.cs-hide') ||
        doc.querySelectorAll('#feed-text span[class^="cs-"]').length > 0);

  // Composer untouched
  const compose = doc.getElementById('compose');
  check('composer never wrapped', compose.querySelectorAll(SPAN).length === 0);
  check('composer text intact', compose.textContent.includes('hello @'));

  // Mention portal untouched — the v6.4 fix
  const portal = doc.getElementById('mention-portal');
  check('mention popup has zero cs-* spans', portal.querySelectorAll(SPAN).length === 0);
  const opt1 = doc.getElementById('mention-opt-1').textContent.split(/\s+/).filter(Boolean).join(' ');
  check('mention option 1 text intact', opt1 === 'Dick Grayson@dick_grayson', JSON.stringify(opt1));

  // Emoji menu untouched
  const menu = doc.getElementById('emoji-menu');
  check('emoji menu has zero cs-* spans', menu.querySelectorAll(SPAN).length === 0);

  // Combobox subtree untouched (input value censoring only applies on blur of input fields,
  // and censorInputFields skips nothing here — but DOM spans must not appear)
  const combo = doc.getElementById('search-combo');
  check('combobox subtree has zero cs-* spans', combo.querySelectorAll(SPAN).length === 0);

  // Dynamic typeahead items appearing AFTER load (real X renders these while typing)
  const list = doc.getElementById('mention-list');
  const dynOpt = doc.createElement('li');
  dynOpt.setAttribute('role', 'option');
  dynOpt.innerHTML = '<div><span>Cocktail Hour</span></div>';
  list.appendChild(dynOpt);
  const dynFeed = doc.createElement('p');
  dynFeed.textContent = 'fresh crap in the timeline';
  doc.getElementById('feed').appendChild(dynFeed);
  await new Promise(r => setTimeout(r, 300));
  check('dynamically added mention option NOT wrapped', dynOpt.querySelectorAll(SPAN).length === 0 &&
        dynOpt.textContent === 'Cocktail Hour');
  check('dynamic feed text still filtered', dynFeed.querySelectorAll(SPAN).length > 0);

  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
