/**
 * Code.gs
 * ---------------------------------------------------------------------------
 * Server-authoritative backend for the Active Pen Company ABC simulation.
 *
 * WHY THIS EXISTS: the original version generated the dataset AND computed
 * the answer key in the browser, so any student could read `state.answers`
 * in DevTools. This file moves dataset generation, answer computation, and
 * grading here. The browser only ever sends student inputs and receives
 * correct/incorrect verdicts (or, when a hint/override is explicitly
 * requested and penalized, a specific revealed value) -- never the full
 * solved answer object.
 *
 * DEPLOYMENT
 *   1. Create/open a Google Sheet that will act as the data store.
 *   2. Extensions -> Apps Script. Paste this file AND CalcEngine.gs into
 *      the project (two separate .gs files).
 *   3. Set a Script Property INSTRUCTOR_ROLL (Project Settings > Script
 *      Properties) if you want an instructor/demo roll number other than
 *      the default below. Do not rely on this for real security; it's a
 *      convenience switch, not an auth system.
 *   4. Deploy > New deployment > Web app.
 *        Execute as: Me
 *        Who has access: Anyone
 *   5. Copy the deployed /exec URL into BACKEND_API_URL in index.html.
 *
 * DATA MODEL (two sheets, auto-created on first run):
 *   Sessions    - one row per attempt-in-progress (ephemeral working state)
 *   Submissions - one row per completed, graded attempt (the research/
 *                 gradebook record of truth, including the raw generated
 *                 dataset for full reproducibility/audit)
 * ---------------------------------------------------------------------------
 */

var MAX_ATTEMPTS = 5;
var DEFAULT_INSTRUCTOR_ROLL = 'ADMIN-000';
var TOLERANCE_RUPEES = 0.5;

// Score composition (must sum to 100):
//   BASE_MAX        - mechanical Phase 1 / 2a / 2b calculation work
//   DILEMMA_MAX      - the 3-way strategic dilemma (Phase 3)
//   PHASE5_MAX       - avoidable-vs-committed cost & capacity-constrained ranking (Phase 5)
//   CUSTOMER_MAX     - customer-level cost distortion (Phase 5b)
// Penalties are expressed relative to BASE_MAX so they keep the same
// relative "bite" (10%/3% of base per use) regardless of how the total is
// split across phases.
var BASE_MAX = 50;
var DILEMMA_MAX = 20;
var PHASE5_MAX = 15;
var CUSTOMER_MAX = 15;
var PENALTY_OVERRIDE = 10; // per emergency override (was -20 of 100; now -10 of a 50-point base)
var PENALTY_HINT = 3;      // per hint requested (was -5 of 100; now -3 of a 50-point base)
var ERROR_UNIT = 1;        // per failed validation attempt
var ERROR_CAP = 10;

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var body = JSON.parse(e.postData.contents);
    var action = body.action;
    var result;
    switch (action) {
      case 'initSession': result = handleInitSession(body); break;
      case 'validatePhase': result = handleValidatePhase(body); break;
      case 'hint': result = handleHint(body); break;
      case 'bypass': result = handleBypass(body); break;
      case 'checkDilemma': result = handleCheckDilemma(body); break;
      case 'submitFinal': result = handleSubmitFinal(body); break;
      default: result = { ok: false, error: 'Unknown action: ' + action };
    }
    return jsonResponse(result);
  } catch (err) {
    return jsonResponse({ ok: false, error: 'Server error: ' + err.message });
  } finally {
    lock.releaseLock();
  }
}

function doGet(e) {
  return jsonResponse({ ok: true, message: 'APC simulation backend is running.' });
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ------------------------------------------------------------------ */
/* Sheet helpers                                                       */
/* ------------------------------------------------------------------ */

function getSheet(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
  }
  return sh;
}

function sessionsSheet() {
  return getSheet('Sessions', [
    'sessionToken', 'roll', 'name', 'isInstructor', 'seed', 'datasetJSON',
    'solutionJSON', 'correctJSON', 'consentAssignment', 'consentResearch',
    'penalties', 'hints', 'errors', 'recalcs', 'dilemmaChoice', 'dilemmaPassed',
    'submitted', 'startTime'
  ]);
}

function submissionsSheet() {
  return getSheet('Submissions', [
    'timestamp', 'name', 'roll', 'researchId', 'consentResearch', 'sessionToken',
    'datasetId', 'attemptNumber', 'finalScore', 'dilemmaChoice', 'dilemmaCorrect', 'dilemmaPassed',
    'baseScore', 'dilemmaScore', 'phase5Score', 'customerLensScore',
    'DecisionAccuracy_Pre', 'DecisionAccuracy_Post', 'LearningGain',
    'Confidence_Pre', 'Confidence_Post', 'CalibrationError_Pre', 'CalibrationError_Post',
    'ConfidenceChange', 'CognitiveLoad_Pre', 'CognitiveLoad_Post', 'CognitiveLoadChange',
    'CompletionTimeSeconds', 'NumberOfErrors', 'HintsRequested', 'NumberOfRecalculations',
    'refSurprised', 'refMisconception', 'refDriver', 'refLearned', 'rebuttalResponse',
    'rawDatasetJSON', 'rawSolutionJSON'
  ]);
}

function findRowByToken(sheet, token) {
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var tokenCol = headers.indexOf('sessionToken');
  for (var i = 1; i < data.length; i++) {
    if (data[i][tokenCol] === token) {
      var rowObj = {};
      headers.forEach(function (h, idx) { rowObj[h] = data[i][idx]; });
      return { rowIndex: i + 1, headers: headers, obj: rowObj };
    }
  }
  return null;
}

function updateRow(sheet, rowIndex, headers, obj) {
  var row = headers.map(function (h) { return obj[h]; });
  sheet.getRange(rowIndex, 1, 1, row.length).setValues([row]);
}

function countAttempts(roll) {
  var sh = submissionsSheet();
  var data = sh.getDataRange().getValues();
  var headers = data[0];
  var rollCol = headers.indexOf('roll');
  var count = 0;
  for (var i = 1; i < data.length; i++) {
    if (data[i][rollCol] === roll) count++;
  }
  return count;
}

/* ------------------------------------------------------------------ */
/* Action handlers                                                     */
/* ------------------------------------------------------------------ */

function handleInitSession(body) {
  var name = (body.name || '').trim();
  var roll = (body.roll || '').trim();
  if (!name || !roll) return { ok: false, error: 'Name and roll number are required.' };
  if (!body.consentAssignment) return { ok: false, error: 'You must acknowledge the assignment terms to proceed.' };

  var instructorRoll = PropertiesService.getScriptProperties().getProperty('INSTRUCTOR_ROLL') || DEFAULT_INSTRUCTOR_ROLL;
  var isInstructor = (roll === instructorRoll);

  if (!isInstructor) {
    var attempts = countAttempts(roll);
    if (attempts >= MAX_ATTEMPTS) {
      return { ok: false, locked: true, error: 'Out of available attempts (' + MAX_ATTEMPTS + ' max).' };
    }
  }

  var sessionToken = Utilities.getUuid();
  var seed = roll + '|' + sessionToken;
  var dataset = generateDataset(seed, isInstructor);
  var solution = calculateSolutions(dataset);
  var correct = deriveCorrectAnswers(dataset, solution);

  var sh = sessionsSheet();
  sh.appendRow([
    sessionToken, roll, name, isInstructor, seed,
    JSON.stringify(dataset), JSON.stringify(solution), JSON.stringify(correct),
    !!body.consentAssignment, !!body.consentResearch,
    0, 0, 0, 0, '', false, false, Date.now()
  ]);

  return {
    ok: true,
    sessionToken: sessionToken,
    datasetId: 'APC-' + sessionToken.slice(0, 8).toUpperCase(),
    attemptNumber: isInstructor ? 1 : (countAttempts(roll) + 1),
    isInstructor: isInstructor,
    displayData: {
      vol: dataset.vol, dm: dataset.dm, dl: dataset.dl, dlRate: dataset.dlRate,
      markup: dataset.markup, runs: dataset.runs, parts: dataset.parts,
      suHours: dataset.suHours, mh: dataset.mh,
      mhPerUnit: dataset.vol.map(function (v, i) { return dataset.mh[i] / v; }),
      cScheduling: dataset.cScheduling, cSetups: dataset.cSetups,
      cParts: dataset.cParts, cMachine: dataset.cMachine, totalOH: dataset.totalOH,
      // Descriptive-only order pattern for the two customers of whichever
      // product turns out ABC-most-profitable. These are raw inputs (order
      // volume/runs/setup/parts), NOT the resulting margins -- the margin
      // comparison is exactly what the student is being asked to work out.
      customerLensContext: {
        productName: correct.winnerProductName,
        alpha: {
          volumeUnits: Math.round(correct.customer.alpha.volumeUnits),
          runs: Math.round(correct.customer.alpha.runs),
          setupHours: Math.round(correct.customer.alpha.setupHours),
          partsLines: Math.round(correct.customer.alpha.partsLines * 10) / 10
        },
        beta: {
          volumeUnits: Math.round(correct.customer.beta.volumeUnits),
          runs: Math.round(correct.customer.beta.runs),
          setupHours: Math.round(correct.customer.beta.setupHours),
          partsLines: Math.round(correct.customer.beta.partsLines * 10) / 10
        }
      }
    },
    state: { penalties: 0, hints: 0, errors: 0, score: BASE_MAX }
  };
}

function loadSession(token) {
  var sh = sessionsSheet();
  var found = findRowByToken(sh, token);
  if (!found) return null;
  found.obj.dataset = JSON.parse(found.obj.datasetJSON);
  found.obj.solution = JSON.parse(found.obj.solutionJSON);
  found.obj.correct = JSON.parse(found.obj.correctJSON);
  return { sheet: sh, rowIndex: found.rowIndex, headers: found.headers, session: found.obj };
}

/** In-progress (pre-submission) score: base component only, since the
 *  dilemma / Phase 5 / customer-lens components aren't answered yet. This
 *  is what the HUD shows while a student works through Phases 1-2b. */
function currentScore(session) {
  var penalties = Number(session.penalties) || 0;
  var hints = Number(session.hints) || 0;
  var errors = Number(session.errors) || 0;
  var deductions = (penalties * PENALTY_OVERRIDE) + (hints * PENALTY_HINT) + Math.min(errors * ERROR_UNIT, ERROR_CAP);
  return Math.max(0, BASE_MAX - deductions);
}

function publicState(session) {
  return {
    penalties: Number(session.penalties) || 0,
    hints: Number(session.hints) || 0,
    errors: Number(session.errors) || 0,
    score: currentScore(session)
  };
}

function withinTolerance(a, b) {
  return Math.abs(Number(a) - Number(b)) <= TOLERANCE_RUPEES;
}

function handleValidatePhase(body) {
  var loaded = loadSession(body.sessionToken);
  if (!loaded) return { ok: false, error: 'Session not found. Please restart.' };
  var session = loaded.session;
  var sol = loaded.session.solution;
  var v = body.values || {};
  var errors = [];

  if (body.phase === 'phase1') {
    if (!withinTolerance(v.rate, sol.p1Rate)) errors.push('Allocation rate is incorrect.');
    for (var i = 0; i < 4; i++) {
      if (!withinTolerance(v.oh && v.oh[i], sol.p1AllocatedOh[i])) errors.push('Allocated overhead is incorrect for product ' + (i + 1) + '.');
      if (!withinTolerance(v.uc && v.uc[i], sol.p1UnitCost[i])) errors.push('Unit cost is incorrect for product ' + (i + 1) + '.');
      if (!withinTolerance(v.tp && v.tp[i], sol.p1Prices[i])) errors.push('Target price is incorrect for product ' + (i + 1) + '.');
    }
  } else if (body.phase === 'phase2a') {
    var expected = [
      { h: 'Batch', d: 'Runs' }, { h: 'Batch', d: 'Setup' },
      { h: 'Product', d: 'Parts' }, { h: 'Facility', d: 'MH' },
      { h: 'Period', d: 'None' }, { h: 'Period', d: 'None' }
    ];
    for (var j = 0; j < 6; j++) {
      var row = (v.rows && v.rows[j]) || {};
      if (row.h !== expected[j].h || row.d !== expected[j].d) {
        errors.push('Row ' + (j + 1) + ' hierarchy/driver classification is incorrect.');
      }
    }
  } else if (body.phase === 'phase2b') {
    var rates = [sol.rSched, sol.rSetup, sol.rParts, sol.rMach];
    for (var r = 0; r < 4; r++) {
      if (!withinTolerance(v.rates && v.rates[r], rates[r])) errors.push('Cost pool rate ' + (r + 1) + ' is incorrect.');
    }
    for (var k = 0; k < 4; k++) {
      if (!withinTolerance(v.aSch && v.aSch[k], sol.aSch[k])) errors.push('Scheduling allocation is incorrect for product ' + (k + 1) + '.');
      if (!withinTolerance(v.aSu && v.aSu[k], sol.aSu[k])) errors.push('Setup allocation is incorrect for product ' + (k + 1) + '.');
      if (!withinTolerance(v.aPts && v.aPts[k], sol.aPts[k])) errors.push('Parts allocation is incorrect for product ' + (k + 1) + '.');
      if (!withinTolerance(v.aMach && v.aMach[k], sol.aMach[k])) errors.push('Machine allocation is incorrect for product ' + (k + 1) + '.');
      if (!withinTolerance(v.uc && v.uc[k], sol.abcUnitCost[k])) errors.push('True ABC unit cost is incorrect for product ' + (k + 1) + '.');
    }
  } else {
    return { ok: false, error: 'Unknown phase: ' + body.phase };
  }

  if (errors.length > 0) {
    session.errors = (Number(session.errors) || 0) + 1;
    updateRow(loaded.sheet, loaded.rowIndex, loaded.headers, session);
    return { ok: false, message: errors[0], allErrors: errors, state: publicState(session) };
  }

  var dashboard = null;
  if (body.phase === 'phase2b') {
    dashboard = {
      vol: session.dataset.vol,
      traditionalUnitCost: sol.p1UnitCost, abcUnitCost: sol.abcUnitCost,
      traditionalPrice: sol.p1Prices, abcPrice: sol.abcPrices
    };
  }
  return { ok: true, state: publicState(session), dashboard: dashboard };
}

function handleHint(body) {
  var loaded = loadSession(body.sessionToken);
  if (!loaded) return { ok: false, error: 'Session not found. Please restart.' };
  var session = loaded.session;
  var sol = session.solution;
  session.hints = (Number(session.hints) || 0) + 1;
  updateRow(loaded.sheet, loaded.rowIndex, loaded.headers, session);

  var text = '';
  if (body.phase === 1) {
    var totalDlCost = session.dataset.vol.reduce(function (acc, v, i) {
      return acc + (v * session.dataset.dl[i] * session.dataset.dlRate);
    }, 0);
    text = 'Total Overhead is ₹' + Math.round(session.dataset.totalOH).toLocaleString() +
      '. Total Direct Labor cost base is ₹' + Math.round(totalDlCost).toLocaleString() +
      '. Target Allocation Rate: ' + sol.p1Rate.toFixed(2) + '%';
  } else if (body.phase === 2) {
    text = 'Scheduling: ₹' + sol.rSched.toFixed(2) + '/run · Setups: ₹' + sol.rSetup.toFixed(2) +
      '/setup hr · Parts: ₹' + sol.rParts.toFixed(2) + '/part · Machine: ₹' + sol.rMach.toFixed(2) + '/MH';
  }
  return { ok: true, hintText: text, state: publicState(session) };
}

function handleBypass(body) {
  var loaded = loadSession(body.sessionToken);
  if (!loaded) return { ok: false, error: 'Session not found. Please restart.' };
  var session = loaded.session;
  var sol = session.solution;
  session.penalties = (Number(session.penalties) || 0) + 1;
  updateRow(loaded.sheet, loaded.rowIndex, loaded.headers, session);

  var values = {};
  if (body.phase === 1) {
    values = { rate: sol.p1Rate, oh: sol.p1AllocatedOh, uc: sol.p1UnitCost, tp: sol.p1Prices };
  } else if (body.phase === 2) {
    values = {
      rows: [
        { h: 'Batch', d: 'Runs' }, { h: 'Batch', d: 'Setup' }, { h: 'Product', d: 'Parts' },
        { h: 'Facility', d: 'MH' }, { h: 'Period', d: 'None' }, { h: 'Period', d: 'None' }
      ]
    };
  } else if (body.phase === 3) {
    values = {
      rates: [sol.rSched, sol.rSetup, sol.rParts, sol.rMach],
      aSch: sol.aSch, aSu: sol.aSu, aPts: sol.aPts, aMach: sol.aMach, uc: sol.abcUnitCost
    };
  }
  return { ok: true, values: values, state: publicState(session) };
}

function handleCheckDilemma(body) {
  var loaded = loadSession(body.sessionToken);
  if (!loaded) return { ok: false, error: 'Session not found. Please restart.' };
  var session = loaded.session;
  var passed = (body.choice === session.correct.dilemma);
  session.dilemmaChoice = body.choice;
  session.dilemmaPassed = passed;
  updateRow(loaded.sheet, loaded.rowIndex, loaded.headers, session);
  return { ok: true, passed: passed, state: publicState(session) };
}

function handleSubmitFinal(body) {
  var loaded = loadSession(body.sessionToken);
  if (!loaded) return { ok: false, error: 'Session not found. Please restart.' };
  var session = loaded.session;

  if (session.submitted) {
    // Idempotent: never grade the same session twice.
    return { ok: true, alreadySubmitted: true, finalScore: currentScore(session) };
  }

  var correct = session.correct;
  var pre = scoreDecisionBlock({
    q1: body.pre.q1, ranking: body.pre.ranking, q3: body.pre.q3, q4: body.pre.q4
  }, correct.traditional);
  var post = scoreDecisionBlock({
    q1: body.post.q1, ranking: body.post.ranking, q3: body.post.q3, q4: body.post.q4
  }, correct.abc);

  var dilemmaPassed = (body.dilemmaChoice === correct.dilemma);
  session.dilemmaChoice = body.dilemmaChoice;
  session.dilemmaPassed = dilemmaPassed;

  // Recompute Phase 5 / customer-lens analysis fresh from the stored
  // dataset+solution rather than trusting anything precomputed client-side.
  var capacity = computeCapacityAnalysis(session.dataset, session.solution, correct.specialtyProductIndex);
  var customerAnalysis = computeCustomerAnalysis(session.dataset, session.solution, correct.winnerProductIndex);
  var phase5 = scorePhase5(body.phase5 || {}, capacity);
  var customerLens = scoreCustomerLens(body.customerLens || {}, customerAnalysis);

  var baseComponent = currentScore(session); // 0..BASE_MAX, penalties/hints/errors already accrued
  var dilemmaComponent = dilemmaPassed ? DILEMMA_MAX : 0;
  var finalScore = Math.max(0, Math.min(100, baseComponent + dilemmaComponent + phase5.score + customerLens.score));

  session.submitted = true;
  updateRow(loaded.sheet, loaded.rowIndex, loaded.headers, session);

  var confidencePre = Number(body.confidencePre);
  var confidencePost = Number(body.confidencePost);
  var cognitiveLoadPre = Number(body.cognitiveLoadPre);
  var cognitiveLoadPost = Number(body.cognitiveLoadPost);
  var completionTime = Math.round((Date.now() - Number(session.startTime)) / 1000);

  var metrics = {
    DecisionAccuracy_Pre: pre.accuracy,
    DecisionAccuracy_Post: post.accuracy,
    LearningGain: post.accuracy - pre.accuracy,
    Confidence_Pre: confidencePre,
    Confidence_Post: confidencePost,
    CalibrationError_Pre: Math.abs(confidencePre - pre.accuracy),
    CalibrationError_Post: Math.abs(confidencePost - post.accuracy),
    ConfidenceChange: confidencePost - confidencePre,
    CognitiveLoad_Pre: cognitiveLoadPre,
    CognitiveLoad_Post: cognitiveLoadPost,
    CognitiveLoadChange: cognitiveLoadPost - cognitiveLoadPre,
    CompletionTime: completionTime
  };

  // Pseudonymous research ID: a one-way hash of roll + a server-side salt.
  // This lets researchers analyze/publish using researchId instead of the
  // identifiable roll/name columns when consentResearch is true.
  var salt = PropertiesService.getScriptProperties().getProperty('RESEARCH_SALT') || 'change-me-salt';
  var researchId = 'R-' + (hashStringToSeed(session.roll + '|' + salt)).toString(16);

  var sub = submissionsSheet();
  sub.appendRow([
    new Date(), session.name, session.roll, researchId, session.consentResearch, session.sessionToken,
    'APC-' + String(session.sessionToken).slice(0, 8).toUpperCase(),
    countAttempts(session.roll) + 1, finalScore,
    body.dilemmaChoice, correct.dilemma, dilemmaPassed,
    baseComponent, dilemmaComponent, phase5.score, customerLens.score,
    metrics.DecisionAccuracy_Pre, metrics.DecisionAccuracy_Post, metrics.LearningGain,
    metrics.Confidence_Pre, metrics.Confidence_Post, metrics.CalibrationError_Pre, metrics.CalibrationError_Post,
    metrics.ConfidenceChange, metrics.CognitiveLoad_Pre, metrics.CognitiveLoad_Post, metrics.CognitiveLoadChange,
    metrics.CompletionTime, Number(session.errors) || 0, Number(session.hints) || 0, Number(body.numberOfRecalculations) || 0,
    body.reflections && body.reflections.surprised, body.reflections && body.reflections.misconception,
    body.reflections && body.reflections.driver, body.reflections && body.reflections.learned,
    body.rebuttal || '',
    session.datasetJSON, session.solutionJSON
  ]);

  return {
    ok: true,
    finalScore: finalScore,
    dilemmaPassed: dilemmaPassed,
    breakdown: {
      base: baseComponent, baseMax: BASE_MAX,
      dilemma: dilemmaComponent, dilemmaMax: DILEMMA_MAX,
      phase5: phase5.score, phase5Max: PHASE5_MAX, phase5Detail: phase5.detail,
      customerLens: customerLens.score, customerLensMax: CUSTOMER_MAX, customerLensDetail: customerLens.detail,
      hints: Number(session.hints) || 0, penalties: Number(session.penalties) || 0,
      errors: Number(session.errors) || 0
    },
    metrics: metrics,
    dashboard: {
      vol: session.dataset.vol,
      traditionalUnitCost: session.solution.p1UnitCost, abcUnitCost: session.solution.abcUnitCost,
      traditionalPrice: session.solution.p1Prices, abcPrice: session.solution.abcPrices
    }
  };
}
