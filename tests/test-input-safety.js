// Input-safety acceptance tests for Censorly content.js (jsdom harness).
// Regression guard for the Bible Gateway bug (v6.6): what the user types in
// input/textarea fields must NEVER be modified — not during initial
// processing, not after blur, and not on JavaScript-driven submissions.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const src = fs.readFileSync(path.join(__dirname, '..', 'chrome', 'content.js'), 'utf8');

const HTML = `<!DOCTYPE html><html><head></head><body>
  <p id="readable">this shit is annoying</p>
  <form id="bg-form" action="/passage">
    <input id="bg-search" type="text" value="holy shit grace">
  </form>
  <input id="plain" type="text" value="damn filter words here">
  <textarea id="note">crap notes</textarea>
</body></html>`;

function buildDom() {
  const dom = new JSDOM(HTML, { runScripts: 'dangerously', url: 'https://www.biblegateway.com/' });
  const w = dom.window;
  w.chrome = {
    runtime: { onMessage: { addListener() {} }, sendMessage() {} },
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
  await new Promise(r => setTimeout(r, 300));
  const w = dom.window, doc = w.document;

  const bg = doc.getElementById('bg-search');
  const plain = doc.getElementById('plain');
  const note = doc.getElementById('note');

  check('search input value untouched', bg.value === 'holy shit grace', bg.value);
  check('plain input value untouched', plain.value === 'damn filter words here', plain.value);
  check('textarea value untouched', note.value === 'crap notes', note.value);

  // simulate the Bible Gateway flow: type, blur (site steals focus for the
  // typeahead), then a JS-driven Enter with no native submit event.
  bg.focus();
  bg.value = 'john 3 shit 16 study';
  bg.blur();
  await new Promise(r => setTimeout(r, 200));
  bg.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  bg.dispatchEvent(new w.KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
  bg.dispatchEvent(new w.Event('submit', { bubbles: true }));
  await new Promise(r => setTimeout(r, 200));
  check('value intact after blur + Enter with no native submit',
        bg.value === 'john 3 shit 16 study', JSON.stringify(bg.value));
  check('no censor flags left on the input', !bg.dataset.csInputCensored, JSON.stringify(bg.dataset));

  // surrounding readable text still filters (the feature itself is intact)
  const span = doc.querySelector('#readable .cs-hide, #readable .cs-censor, #readable .cs-blur');
  check('read-only text still filtered', !!span, 'no cs span found in #readable');

  // the value-swap machinery must be gone from the source entirely
  check('input value swap code removed from source',
        !/originalInputValues|censorInputFields|csInputCensored/.test(src));

  if (failures) { console.log(`\n${failures} FAILURES`); process.exit(1); }
  console.log('\nAll input-safety checks passed');
})();
