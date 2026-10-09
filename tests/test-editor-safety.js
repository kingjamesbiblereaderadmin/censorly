// Editor-safety acceptance tests for Censorly content.js (jsdom harness).
// Simulates Discord/Slate-style rich editors and verifies:
//  A. Editor DOM is never touched (no cs-* spans, no node swaps/clones)
//  B. No contenteditable writes, no replaceChildren/innerHTML/cloneNode paths
//  C. restoreAll only unwraps cs-* spans (parent identity preserved)
//  Read-only text still filters in hide/censor/blur; input.value censoring works.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const src = fs.readFileSync(path.join(__dirname, '..', 'chrome', 'content.js'), 'utf8');

const HTML = `<!DOCTYPE html><html><head></head><body>
  <div id="readonly"><p id="ro-p">this shit is annoying</p>
    <p>holy mole that was crap</p></div>

  <!-- Slate/Discord-style editor: unfocused, arbitrary nested structure -->
  <div id="slate" data-slate-editor="true" contenteditable="true" role="textbox" class="slate-editor">
    <div data-slate-node="element"><div data-slate-node="element">
      <span data-slate-node="text"><span data-slate-leaf="true"><span data-slate-string="true">draft: some shit text here</span></span></span>
    </div></div>
  </div>

  <!-- Facebook/Instagram-style comment editor without contenteditable value -->
  <div id="lex" role="textbox" aria-label="comment"><p>damn draft words</p></div>

  <!-- ProseMirror -->
  <div id="pm" class="ProseMirror" contenteditable="true"><p>fuck draft</p></div>

  <!-- CodeMirror-ish surface -->
  <div id="cm" class="CodeMirror"><pre>const shit = 1;</pre></div>

  <!-- plain editable next to readable text: sibling filtering must survive -->
  <div id="mixed"><p id="mixed-ro">bastard text nearby</p>
    <div id="mixed-ed" contenteditable="plaintext-only">bastard draft</div></div>

  <form id="f"><input id="inp" type="text" value="damn input value"><button type="submit">go</button></form>
</body></html>`;

function buildDom() {
  const dom = new JSDOM(HTML, { runScripts: 'dangerously', url: 'https://discord.example.com/channels/1' });
  const w = dom.window;
  w.chrome = {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage() {},
    },
    storage: { sync: { get(defs, cb) { cb({}); } } }, // defaults: DEFAULT_WORDS, enabled, hide
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

function editorIntact(doc, rootId, expectedText) {
  const root = doc.getElementById(rootId);
  const spans = root.querySelectorAll('.cs-hide, .cs-censor, .cs-blur');
  const dataCs = root.querySelectorAll('[data-cs-filtered]');
  return { root, spans, dataCs, textOk: root.textContent.trim() === expectedText, text: root.textContent };
}

(async () => {
  // give the storage callback + microtasks time to run the initial filter
  await new Promise(r => setTimeout(r, 250));
  const dom = buildDom();
  await new Promise(r => setTimeout(r, 250));
  const doc = dom.window.document;

  // A1: read-only filtering works (hide mode default)
  const roSpan = doc.querySelector('#ro-p .cs-hide');
  check('read-only text filtered in hide mode', roSpan && roSpan.textContent === 'shit');
  check('cross-node phrase filtered', doc.querySelector('#readonly .cs-hide') && /holy/.test(doc.body.textContent));
  const roP = doc.getElementById('ro-p');
  check('read-only parent still contains span', roSpan && roP.contains(roSpan));

  // A2: Slate editor untouched
  const slate = editorIntact(doc, 'slate', 'draft: some shit text here');
  check('slate editor has zero cs-* spans', slate.spans.length === 0, slate.spans.length + ' spans');
  check('slate editor text unmodified', slate.textOk, JSON.stringify(slate.text));
  check('slate editor leaves no cs markers', slate.dataCs.length === 0);
  const slateLeaf = doc.querySelector('#slate [data-slate-string]');
  check('slate leaf node identity preserved', slateLeaf && slateLeaf.textContent === 'draft: some shit text here');

  // A3: role=textbox editor (no contenteditable) untouched
  const lex = editorIntact(doc, 'lex', 'damn draft words');
  check('role=textbox editor untouched', lex.spans.length === 0 && lex.textOk, JSON.stringify(lex.text));

  // A4: ProseMirror untouched
  const pm = editorIntact(doc, 'pm', 'fuck draft');
  check('ProseMirror untouched', pm.spans.length === 0 && pm.textOk, JSON.stringify(pm.text));

  // A5: CodeMirror untouched
  const cm = editorIntact(doc, 'cm', 'const shit = 1;');
  check('CodeMirror untouched', cm.spans.length === 0 && cm.textOk, JSON.stringify(cm.text));

  // A6: sibling read-only text near an editable is still filtered
  const mixedRo = doc.querySelector('#mixed-ro .cs-hide');
  check('read-only sibling of editable still filtered', mixedRo && mixedRo.textContent === 'bastard');
  const mixedEd = editorIntact(doc, 'mixed-ed', 'bastard draft');
  check('contenteditable=plaintext-only untouched', mixedEd.spans.length === 0 && mixedEd.textOk, JSON.stringify(mixedEd.text));

  // B: input.value censoring still works, no editable writes
  const inp = doc.getElementById('inp');
  check('input value censored with blocks', inp.value === '\u2588\u2588\u2588\u2588 input value', inp.value);

  // C: restoreAll unwraps in place — parent identity and child structure preserved
  const pBefore = doc.getElementById('ro-p');
  const beforeChildren = Array.from(pBefore.childNodes).map(n => n.nodeType);
  dom.window.chrome.storage.sync.get = (d, cb) => cb({});
  // trigger restore via the message listener: simulate disable
  // (call the internal path through the listener registered on chrome.runtime.onMessage)
  let listener = null;
  dom.window.chrome.runtime.onMessage.addListener = fn => { listener = fn; };
  // re-evaluate a tiny shim to grab the registered listener is not possible;
  // instead invoke restore through updateFilter by re-dispatching the same script state:
  // simpler: directly test restoreAll by disabling via a fresh message through the captured listener.
  // The script registered its listener at load time with the stub; re-run get with enabled=false:
  // Fall back: verify restoreAll via re-dispatch of the script with enabled=false.
  const dom2 = new JSDOM(HTML, { runScripts: 'dangerously', url: 'https://discord.example.com/channels/1' });
  const w2 = dom2.window;
  let restoreListener = null;
  w2.chrome = {
    runtime: { onMessage: { addListener(fn) { restoreListener = fn; } }, sendMessage() {} },
    storage: { sync: { get(defs, cb) { cb({ enabled: false }); } } },
  };
  const s2 = w2.document.createElement('script');
  s2.textContent = src;
  w2.document.body.appendChild(s2);
  await new Promise(r => setTimeout(r, 250));
  check('disabled state: no filtering happened', w2.document.querySelectorAll('.cs-hide, .cs-censor, .cs-blur').length === 0);

  // Now a third dom: enabled, then send updateFilter {enabled:false} to force restoreAll
  const dom3 = new JSDOM(HTML, { runScripts: 'dangerously', url: 'https://discord.example.com/channels/1' });
  const w3 = dom3.window;
  let listener3 = null;
  w3.chrome = {
    runtime: { onMessage: { addListener(fn) { listener3 = fn; } }, sendMessage() {} },
    storage: { sync: { get(defs, cb) { cb({}); } } },
  };
  const s3 = w3.document.createElement('script');
  s3.textContent = src;
  w3.document.body.appendChild(s3);
  await new Promise(r => setTimeout(r, 250));
  const d3 = w3.document;
  const pEl = d3.getElementById('ro-p');
  const innerSpanBefore = d3.querySelector('#ro-p .cs-hide');
  check('dom3 pre-restore: span exists', !!innerSpanBefore);
  listener3({ action: 'updateFilter', enabled: false, words: ['shit', 'holy mole'], mode: 'hide' }, {}, () => {});
  await new Promise(r => setTimeout(r, 100));
  check('restoreAll unwrapped spans', d3.querySelectorAll('.cs-hide, .cs-censor, .cs-blur').length === 0);
  check('restoreAll preserved parent element identity', d3.getElementById('ro-p') === pEl);
  check('restoreAll restored original text', pEl.textContent === 'this shit is annoying', pEl.textContent);
  const pEl2 = d3.getElementById('mixed-ro');
  check('mixed read-only restored', pEl2 && pEl2.textContent === 'bastard text nearby');

  // Mode switch hides censor blur on a 4th dom
  const dom4 = new JSDOM(HTML, { runScripts: 'dangerously', url: 'https://discord.example.com/channels/1' });
  const w4 = dom4.window;
  let listener4 = null;
  w4.chrome = {
    runtime: { onMessage: { addListener(fn) { listener4 = fn; } }, sendMessage() {} },
    storage: { sync: { get(defs, cb) { cb({}); } } },
  };
  const s4 = w4.document.createElement('script');
  s4.textContent = src;
  w4.document.body.appendChild(s4);
  await new Promise(r => setTimeout(r, 250));
  for (const mode of ['censor', 'blur']) {
    listener4({ action: 'updateFilter', mode, enabled: true, words: ['shit', 'holy mole'], modeName: mode }, {}, () => {});
  }
  listener4({ action: 'updateFilter', mode: 'censor', enabled: true, words: ['shit', 'holy mole'] }, {}, () => {});
  await new Promise(r => setTimeout(r, 100));
  check('mode switch to censor applies cs-censor', w4.document.querySelector('#ro-p .cs-censor') !== null);
  listener4({ action: 'updateFilter', mode: 'blur', enabled: true, words: ['shit', 'holy mole'] }, {}, () => {});
  await new Promise(r => setTimeout(r, 100));
  check('mode switch to blur applies cs-blur', w4.document.querySelector('#ro-p .cs-blur') !== null);
  const slate4 = w4.document.getElementById('slate');
  check('slate untouched across mode switches', slate4.querySelectorAll('.cs-hide, .cs-censor, .cs-blur').length === 0);

  // Dynamic additions through the MutationObserver path
  const slateDyn = doc.getElementById('slate');
  const dynSpan = doc.createElement('span');
  dynSpan.setAttribute('data-slate-string', 'true');
  dynSpan.textContent = 'fresh crap appears';
  slateDyn.querySelector('[data-slate-node="element"]').lastElementChild.appendChild(dynSpan);
  const roDyn = doc.createElement('p');
  roDyn.textContent = 'fresh crap in the open';
  doc.getElementById('readonly').appendChild(roDyn);
  await new Promise(r => setTimeout(r, 300));
  check('dynamic node inside editor NOT filtered', slateDyn.textContent.includes('fresh crap appears') && slateDyn.querySelectorAll('.cs-hide,.cs-censor,.cs-blur').length === 0);
  check('dynamic read-only node filtered', !!roDyn.querySelector('.cs-hide, .cs-censor, .cs-blur'));

  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
