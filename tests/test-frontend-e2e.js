/**
 * test-frontend-e2e.js
 * ---------------------------------------------------------------------------
 * Loads the ACTUAL frontend/index.html into jsdom and drives it through the
 * entire flow -- consent, all four calculation phases (via the real
 * Emergency Override buttons, which round-trip through the real backend),
 * the what-if explorer, Phase 5, the customer lens, the dilemma, and final
 * submission -- with `fetch` routed to an in-memory instance of the real
 * Code.gs + CalcEngine.gs (same mocking approach as
 * test-backend-integration.js). This is the closest thing to a real browser
 * click-through we can run headlessly, and it catches any place where the
 * HTML's element IDs, the inline `onclick` handlers, and the JS functions
 * they call have drifted out of sync with each other.
 *
 * Run with: node tests/test-frontend-e2e.js
 * (requires `npm install jsdom` in this directory first)
 * ---------------------------------------------------------------------------
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; } else { failed++; console.error('FAIL:', label); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  // ---- Backend: same sandboxed Code.gs + CalcEngine.gs as the integration test ----
  function makeSheet() {
    let rows = [];
    return {
      appendRow(row) { rows.push(row.slice()); },
      getDataRange() { return { getValues: () => rows.map(r => r.slice()) }; },
      getRange(rowIndex) { return { setValues: values => { rows[rowIndex - 1] = values[0].slice(); } }; },
      setFrozenRows() {}, _dump: () => rows
    };
  }
  const sheets = {};
  const scriptProps = { INSTRUCTOR_ROLL: 'TEST-INSTRUCTOR', RESEARCH_SALT: 'test-salt' };
  const backendSandbox = {
    console,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheetByName: name => sheets[name] || null,
        insertSheet: name => { sheets[name] = makeSheet(); return sheets[name]; }
      })
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => scriptProps[k] }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: { getUuid: () => 'uuid-' + Math.random().toString(36).slice(2) },
    ContentService: {
      MimeType: { JSON: 'JSON' },
      createTextOutput(str) { return { _content: str, setMimeType() { return this; }, getContent() { return this._content; } }; }
    },
    module: { exports: {} }
  };
  vm.createContext(backendSandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'backend', 'CalcEngine.gs'), 'utf8'), backendSandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'backend', 'Code.gs'), 'utf8'), backendSandbox);
  function backendCall(action, payload) {
    backendSandbox.__e__ = { postData: { contents: JSON.stringify({ action, ...payload }) } };
    const output = vm.runInContext('doPost(__e__)', backendSandbox);
    return JSON.parse(output.getContent());
  }

  // ---- Frontend: real index.html in jsdom, fetch routed to the backend above ----
  const html = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'https://example.com/' });
  const { window } = dom;

  // jsdom does not implement innerText (only textContent). The app uses
  // innerText extensively, so alias it -- this is a jsdom limitation being
  // worked around for the test harness, not a change to app behavior.
  Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
    get() { return this.textContent; },
    set(value) { this.textContent = value; },
    configurable: true
  });

  window.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const result = backendCall(body.action, body);
    return { ok: true, status: 200, json: async () => result };
  };
  window.confirm = () => true;
  window.alert = (msg) => { window.__lastAlert = msg; };
  if (typeof window.Blob === 'undefined') window.Blob = class { constructor(parts, opts) { this.parts = parts; this.type = opts && opts.type; } };
  if (typeof window.URL.createObjectURL === 'undefined') window.URL.createObjectURL = () => 'blob:mock';

  const doc = window.document;
  const $ = id => doc.getElementById(id);
  const activeScreenId = () => {
    const active = doc.querySelector('.screen.active');
    return active ? active.id : null;
  };

  // Let the initial inline <script> finish executing.
  await sleep(50);

  // ---- Step 0: consent + login ----
  $('consent-assignment').checked = true;
  $('consent-research').checked = true;
  $('student-name').value = 'Test Student';
  $('student-roll').value = 'TEST-INSTRUCTOR';
  window.initializeSimulation();
  await sleep(50);
  ok(activeScreenId() === 'screen-1', `after init, screen-1 is active (got ${activeScreenId()})`);
  ok($('hud').style.display === 'flex', 'HUD becomes visible after init');
  ok($('d-vol0').innerText.length > 0, 'briefing ledger populated from server displayData');

  // ---- Screen 1: briefing -> Phase 1 ----
  window.nextScreen(2, true);
  ok(activeScreenId() === 'screen-2', 'briefing "Proceed" reaches screen-2 (Phase 1)');

  // ---- Phase 1: use the real Emergency Override button path ----
  window.autoBypass(1);
  await sleep(50);
  ok($('alert-2').className.includes('alert-success'), 'Phase 1 override + validate succeeds (alert-2 shows success)');
  ok($('hud-penalties').innerText.includes('10'), 'HUD reflects the -10 pt override penalty');
  $('alert-2').querySelector('button').click();
  ok(activeScreenId() === 'screen-2_5', 'proceeding from Phase 1 reaches the pre-assessment screen');

  // ---- Pre-assessment: fill with the mathematically correct answers ----
  $('pre-q1').value = 'Equal'; $('pre-r1').value = 'Equal'; $('pre-r2').value = 'Equal';
  $('pre-r3').value = 'Equal'; $('pre-r4').value = 'Equal'; $('pre-q3').value = 'All'; $('pre-q4').value = 'NO';
  $('cl-pre').value = '5';
  await window.submitPreAssessment();
  ok(activeScreenId() === 'screen-3', 'pre-assessment submission reaches Phase 2a');

  // ---- Phase 2a ----
  window.autoBypass(2);
  await sleep(50);
  ok($('alert-3').className.includes('alert-success'), 'Phase 2a override + validate succeeds');
  $('alert-3').querySelector('button').click();
  ok(activeScreenId() === 'screen-4', 'proceeding from Phase 2a reaches Phase 2b');

  // ---- Phase 2b ----
  window.autoBypass(3);
  await sleep(50);
  ok($('alert-4').className.includes('alert-success'), 'Phase 2b override + validate succeeds');
  ok($('dashboard-tbody').innerHTML.includes('Purple'), 'dashboard renders after Phase 2b success');
  $('alert-4').querySelector('button').click();
  ok(activeScreenId() === 'screen-5', 'proceeding from Phase 2b reaches the dashboard');

  // ---- What-if explorer (ungraded) ----
  $('whatif-product').value = '3'; // Purple
  $('whatif-slider').value = '50';
  window.renderWhatIf();
  ok($('whatif-output').innerHTML.includes('Purple'), 'what-if explorer renders for the selected product');
  ok(/₹\d/.test($('whatif-output').innerHTML), 'what-if explorer shows a computed rupee cost');

  window.nextScreen('5_5', false);
  ok(activeScreenId() === 'screen-5_5', 'dashboard "Proceed" reaches the post-assessment');

  // ---- Post-assessment: fill with the mathematically correct answers ----
  $('post-q1').value = 'Blue'; $('post-r1').value = 'Blue'; $('post-r2').value = 'Black';
  $('post-r3').value = 'Red'; $('post-r4').value = 'Purple'; $('post-q3').value = 'Blue'; $('post-q4').value = 'NO';
  $('cl-post').value = '4';
  await window.submitPostAssessment();
  ok(activeScreenId() === 'screen-5a', 'post-assessment submission reaches Phase 5');

  // ---- Phase 5: capacity & committed cost ----
  $('p5-class-scheduling').value = 'Committed';
  $('p5-class-setups').value = 'Committed';
  $('p5-class-parts').value = 'Avoidable';
  $('p5-class-machine').value = 'Committed';
  $('p5-reduction').value = '47';
  $('p5-rank1').value = 'Blue'; $('p5-rank2').value = 'Black'; $('p5-rank3').value = 'Red'; $('p5-rank4').value = 'Purple';
  window.submitPhase5();
  ok(activeScreenId() === 'screen-5b', 'Phase 5 submission reaches the customer lens');
  ok($('customer-lens-tbody').innerHTML.includes('Alpha') && $('customer-lens-tbody').innerHTML.includes('Beta'),
    'customer lens table is populated with both customers');

  // ---- Phase 5b: customer lens ----
  $('p5b-customer').value = 'Beta';
  $('p5b-gap').value = '5.26';
  window.submitCustomerLens();
  ok(activeScreenId() === 'screen-6', 'customer lens submission reaches the dilemma');
  ok($('optC-text').innerText.length > 0, 'dilemma now offers a third (right-size) option');

  // ---- Dilemma ----
  $('dilemma-choice').value = 'B'; // correct answer for this fixture, per CalcEngine tests
  await window.validateDilemma();
  await sleep(2200); // validateDilemma has a real 2s setTimeout before advancing
  ok(activeScreenId() === 'screen-7', 'correct dilemma choice advances to the reflection screen');

  // ---- Reflection + rebuttal ----
  $('ref-rebuttal').value = 'A rebuttal.';
  $('ref-surprised').value = 'x'; $('ref-misconception').value = 'y';
  $('ref-driver').value = 'z'; $('ref-learned').value = 'w';
  await window.processFinalMetricsAndSubmit();
  await sleep(100);
  ok(activeScreenId() === 'screen-8', 'final submission reaches the summary screen');
  ok($('alert-8').className.includes('alert-success'), 'submission reports success');
  ok($('final-score-val').innerText.endsWith('%'), 'final score is displayed');
  ok($('score-phase5').innerText === '15', `Phase 5 perfect answers score 15/15 (got ${$('score-phase5').innerText})`);
  ok($('score-customer').innerText === '15', `customer lens perfect answers score 15/15 (got ${$('score-customer').innerText})`);
  ok($('score-dil').innerText === '20', `correct dilemma scores full 20 (got ${$('score-dil').innerText})`);
  console.log('Final score shown to student:', $('final-score-val').innerText,
    '| base:', $('score-base').innerText, 'dilemma:', $('score-dil').innerText,
    'phase5:', $('score-phase5').innerText, 'customer:', $('score-customer').innerText);

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('HARNESS ERROR:', err); process.exit(1); });
