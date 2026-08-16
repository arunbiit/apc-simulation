/**
 * test-calc-engine.js
 * ---------------------------------------------------------------------------
 * Loads the ACTUAL backend/CalcEngine.gs file (not a copy) and asserts its
 * output against hand-calculated values for the deterministic instructor
 * dataset (variance = 1.0). Run with: node tests/test-calc-engine.js
 *
 * Because this test loads the real .gs file used in production, any change
 * to the grading math is automatically checked against these fixtures --
 * there is no separate "test version" of the logic to fall out of sync.
 * ---------------------------------------------------------------------------
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const gsPath = path.join(__dirname, '..', 'backend', 'CalcEngine.gs');
const source = fs.readFileSync(gsPath, 'utf8');

const sandbox = { module: { exports: {} }, console };
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'CalcEngine.gs' });
const CalcEngine = sandbox.module.exports;

let passed = 0, failed = 0;
function approx(actual, expected, tol, label) {
  const ok = Math.abs(actual - expected) <= tol;
  if (ok) { passed++; }
  else { failed++; console.error(`FAIL: ${label} — expected ${expected}, got ${actual}`); }
  return ok;
}
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; }
  else { failed++; console.error(`FAIL: ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
  return ok;
}

// ---------------------------------------------------------------------
// Fixture: instructor mode => variance is forced to 1.0, fully deterministic.
// Expected values below (see README.md "Worked numbers" section):
//   totalDlCost = 400,000        p1Rate = 167.5%
//   p1UnitCost  = 15.70 for ALL four products (identical -> "Equal")
//   p1Price     = 21.98 for all
//   rSched=1384.6154 rSetup=550 rParts=5555.5556 rMach=12.766
//   abcUnitCost ≈ [12.2312, 12.9113, 29.9128, 101.3426]
// ---------------------------------------------------------------------
const d = CalcEngine.generateDataset('TEST-SEED', true);
const sol = CalcEngine.calculateSolutions(d);
const correct = CalcEngine.deriveCorrectAnswers(d, sol);

console.log('--- Dataset sanity ---');
assertEqual(d.vol, [50000, 40000, 8000, 2000], 'instructor volumes unscaled');
approx(d.totalOH, 670000, 0.01, 'totalOH');

console.log('--- Traditional costing ---');
approx(sol.p1Rate, 167.5, 0.01, 'p1Rate');
[0, 1, 2, 3].forEach(i => approx(sol.p1UnitCost[i], 15.70, 0.01, `p1UnitCost[${i}]`));
[0, 1, 2, 3].forEach(i => approx(sol.p1Prices[i], 21.98, 0.01, `p1Prices[${i}]`));

console.log('--- ABC costing ---');
// Machine hours per unit are now product-specific (0.08/0.09/0.15/0.30),
// not a flat 0.1 for everyone -- see the comment in generateDataset() for
// why (a uniform ratio would make the Phase 5 capacity-constrained ranking
// mathematically identical to the plain profitability ranking).
assertEqual(d.mh, [4000, 3600, 1200, 600], 'mh reflects per-product machine-hour intensity');
approx(sol.rSched, 1384.6154, 0.01, 'rSched');
approx(sol.rSetup, 550, 0.01, 'rSetup');
approx(sol.rParts, 5555.5556, 0.01, 'rParts');
approx(sol.rMach, 12.766, 0.01, 'rMach');
approx(sol.abcUnitCost[0], 12.2312, 0.01, 'abcUnitCost[Blue]');
approx(sol.abcUnitCost[1], 12.9113, 0.01, 'abcUnitCost[Black]');
approx(sol.abcUnitCost[2], 29.9128, 0.01, 'abcUnitCost[Red]');
approx(sol.abcUnitCost[3], 101.3426, 0.05, 'abcUnitCost[Purple]');

console.log('--- Derived correct answers (regression guard for the fixed bug) ---');
// The original tool hardcoded 'Blue' as the correct pre-ABC "most profitable"
// answer. That is WRONG: traditional unit costs are mathematically identical
// across all four products in this model, so the correct answer is 'Equal'.
assertEqual(correct.traditional.mostProfitable, 'Equal', 'traditional.mostProfitable should be Equal (bug fix regression guard)');
assertEqual(correct.traditional.capitalInvestment, 'All', 'traditional.capitalInvestment should be All (bug fix regression guard)');
assertEqual(correct.traditional.ranking, ['Equal', 'Equal', 'Equal', 'Equal'], 'traditional.ranking should be all Equal');

assertEqual(correct.abc.mostProfitable, 'Blue', 'abc.mostProfitable');
assertEqual(correct.abc.ranking, ['Blue', 'Black', 'Red', 'Purple'], 'abc.ranking');
assertEqual(correct.abc.capitalInvestment, 'Blue', 'abc.capitalInvestment');
assertEqual(correct.abc.expand, 'NO', 'abc.expand (Purple margin destruction should block expansion)');
assertEqual(correct.dilemma, 'B', 'dilemma correct choice');

console.log('--- Seeded reproducibility ---');
const dAgain = CalcEngine.generateDataset('SEED-A', false);
const dRepeat = CalcEngine.generateDataset('SEED-A', false);
assertEqual(dAgain, dRepeat, 'same seed produces identical dataset (reproducibility)');
const dOther = CalcEngine.generateDataset('SEED-B', false);
if (JSON.stringify(dAgain) === JSON.stringify(dOther)) {
  failed++; console.error('FAIL: different seeds produced identical datasets (no entropy)');
} else { passed++; }

console.log('--- Phase 5: capacity & committed-cost analysis ---');
// Cross-check computeCapacityAnalysis's output by independently
// recomputing a couple of its numbers directly from sol, rather than
// trusting the function to grade itself.
const specIdx = correct.specialtyProductIndex;
const capacity = correct.capacity;
const independentAvoidableAlloc =
  sol.aSch[specIdx] * CalcEngine.AVOIDABLE_FRACTIONS.scheduling +
  sol.aSu[specIdx] * CalcEngine.AVOIDABLE_FRACTIONS.setups +
  sol.aPts[specIdx] * CalcEngine.AVOIDABLE_FRACTIONS.parts +
  sol.aMach[specIdx] * CalcEngine.AVOIDABLE_FRACTIONS.machine;
const independentTotalAlloc = sol.aSch[specIdx] + sol.aSu[specIdx] + sol.aPts[specIdx] + sol.aMach[specIdx];
approx(capacity.avoidablePct, (independentAvoidableAlloc / independentTotalAlloc) * 100, 0.01, 'avoidablePct matches independent recomputation');
assertEqual(capacity.classification.parts, 'Avoidable', 'parts pool classified Avoidable (fraction 0.80 > 0.5)');
assertEqual(capacity.classification.scheduling, 'Committed', 'scheduling pool classified Committed (fraction 0.15 <= 0.5)');
assertEqual(capacity.classification.setups, 'Committed', 'setups pool classified Committed (fraction 0.20 <= 0.5)');
assertEqual(capacity.classification.machine, 'Committed', 'machine pool classified Committed (fraction 0.50 is not > 0.5, documented tie-break)');
if (capacity.throughputRanking.length !== 4) { failed++; console.error('FAIL: throughputRanking should have 4 entries'); } else { passed++; }

console.log('--- Phase 5b: customer-level distortion ---');
const winnerIdx = correct.winnerProductIndex;
const customer = correct.customer;
// Independently recompute Beta's margin per unit and compare.
const betaShares = CalcEngine.CUSTOMER_SHARES.beta;
const betaVol = d.vol[winnerIdx] * betaShares.volShare;
const betaRevenue = sol.p1Prices[winnerIdx] * betaVol;
const betaOh = (d.runs[winnerIdx] * betaShares.runShare) * sol.rSched
  + (d.suHours[winnerIdx] * betaShares.setupShare) * sol.rSetup
  + (d.parts[winnerIdx] * betaShares.partsShare) * sol.rParts
  + (d.mh[winnerIdx] * betaShares.volShare) * sol.rMach;
const betaDmDl = (d.dm[winnerIdx] + d.dl[winnerIdx] * d.dlRate) * betaVol;
const betaMarginPerUnitIndependent = (betaRevenue - betaOh - betaDmDl) / betaVol;
approx(customer.beta.marginPerUnit, betaMarginPerUnitIndependent, 0.01, 'customer.beta.marginPerUnit matches independent recomputation');
assertEqual(customer.lessProfitable, 'Beta', 'Beta (small, frequent, high-touch orders) is the less profitable customer in this fixture');
if (customer.marginGapPerUnit <= 0) { failed++; console.error('FAIL: marginGapPerUnit should be a positive distance'); } else { passed++; }

console.log('--- Upgraded 3-way dilemma ---');
// A: only correct when the specialty line is NOT undercosted by tradition.
// In this fixture it clearly is, so A must never be correct here.
if (correct.dilemma === 'A') { failed++; console.error('FAIL: dilemma should never resolve to A when the specialty line is undercosted'); } else { passed++; }
// With this dataset's magnitude of distortion, even the avoidable-only
// cost basis still exceeds price for the specialty product, so a full
// exit (B) -- not the nuanced right-size (C) -- is the mathematically
// correct call. This assertion pins that down as a regression guard: if
// someone changes AVOIDABLE_FRACTIONS or the base dataset, this is the
// number that will need re-deriving, not silently drift.
assertEqual(correct.dilemma, 'B', 'dilemma resolves to full exit (B) given current AVOIDABLE_FRACTIONS + base dataset magnitudes');
if (capacity.specialtyContributionMargin >= 0) { failed++; console.error('FAIL: specialtyContributionMargin should be negative, consistent with dilemma=B'); } else { passed++; }

console.log('--- Scoring block ---');
const perfectScore = CalcEngine.scoreDecisionBlock({
  q1: 'Equal', ranking: ['Equal', 'Equal', 'Equal', 'Equal'], q3: 'All', q4: 'NO'
}, correct.traditional);
assertEqual(perfectScore.accuracy, 100, 'perfect pre-assessment scores 100');

const zeroScore = CalcEngine.scoreDecisionBlock({
  q1: 'Purple', ranking: ['Purple', 'Red', 'Black', 'Blue'], q3: 'Purple', q4: 'YES'
}, correct.abc);
assertEqual(zeroScore.accuracy, 0, 'fully-wrong post-assessment scores 0');

const perfectPhase5 = CalcEngine.scorePhase5({
  classification: capacity.classification,
  reductionEstimate: capacity.avoidablePct,
  throughputRanking: capacity.throughputRanking
}, capacity);
assertEqual(perfectPhase5.score, 15, 'perfect Phase 5 answers score full 15');

const zeroPhase5 = CalcEngine.scorePhase5({
  classification: { scheduling: 'Avoidable', setups: 'Avoidable', parts: 'Committed', machine: 'Avoidable' },
  reductionEstimate: 0,
  throughputRanking: ['Purple', 'Red', 'Black', 'Blue']
}, capacity);
assertEqual(zeroPhase5.score, 0, 'fully-wrong Phase 5 answers score 0');

const perfectCustomerLens = CalcEngine.scoreCustomerLens({
  lessProfitableCustomer: customer.lessProfitable, marginGapEstimate: customer.marginGapPerUnit
}, customer);
assertEqual(perfectCustomerLens.score, 15, 'perfect customer-lens answers score full 15');

const zeroCustomerLens = CalcEngine.scoreCustomerLens({
  lessProfitableCustomer: customer.lessProfitable === 'Beta' ? 'Alpha' : 'Beta', marginGapEstimate: 0
}, customer);
assertEqual(zeroCustomerLens.score, 0, 'fully-wrong customer-lens answers score 0');

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
