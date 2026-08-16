/**
 * CalcEngine.gs
 * ---------------------------------------------------------------------------
 * PURE calculation engine for the Active Pen Company ABC simulation.
 *
 * This file contains NO Google Apps Script API calls (no SpreadsheetApp,
 * no ContentService, etc.) and NO browser globals. That is intentional:
 * the exact same file is loaded by Code.gs (the Apps Script backend) AND
 * by tests/test-calc-engine.js (a plain Node test, via vm.runInContext).
 *
 * This is the single source of truth for "what is the correct answer."
 * The client (index.html) never re-implements this logic and never sees
 * the solved values except through the controlled hint/bypass/validate
 * endpoints in Code.gs. Keeping the math in exactly one place, tested by
 * a fixture with hand-verified numbers, is what makes the grading
 * defensible for both classroom use and research publication.
 * ---------------------------------------------------------------------------
 */

/** Deterministic seeded PRNG (mulberry32). Math.random() is NOT seedable,
 *  which is what made the original tool's datasets non-reproducible. */
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a style string hash -> 32-bit unsigned seed. */
function hashStringToSeed(str) {
  var h = 2166136261;
  for (var i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Generates the per-attempt scenario dataset.
 * @param {string} seedString - unique per attempt (e.g. roll + "|" + sessionToken).
 *   Storing this seed (and the resulting dataset) lets any submission be
 *   reproduced exactly later for audit/research purposes.
 * @param {boolean} isInstructor - instructor/demo mode uses variance = 1.0
 *   (fixed, hand-checkable numbers) instead of a randomized attempt.
 */
function generateDataset(seedString, isInstructor) {
  var rng = mulberry32(hashStringToSeed(String(seedString)));
  var variance = isInstructor ? 1.0 : (0.85 + rng() * 0.3);

  var baseVol = [50000, 40000, 8000, 2000];
  var baseRuns = [40, 40, 30, 20];
  var suMultiplier = [2, 2, 4, 6];
  // Machine time per unit is NOT uniform across products: Purple's smaller,
  // more delicate batches run slower per unit on the machine. This matters
  // for Phase 5 (capacity-constrained decisions) -- if every product used
  // identical machine hours per unit, ranking by "contribution per hour of
  // the scarce resource" would trivially collapse into the same ordering as
  // ranking by plain unit margin, which defeats the point of the exercise.
  var mhPerUnit = [0.08, 0.09, 0.15, 0.30];

  var vol = baseVol.map(function (v) { return Math.round(v * variance); });
  var runs = baseRuns.map(function (v) { return Math.round(v * variance); });

  var data = {
    seed: seedString,
    variance: variance,
    vol: vol,
    dm: [5.00, 5.00, 5.00, 5.00],
    dl: [0.02, 0.02, 0.02, 0.02],
    dlRate: 200,
    markup: 1.40,
    runs: runs,
    parts: [2, 2, 8, 15],
    suHours: runs.map(function (r, i) { return r * suMultiplier[i]; }),
    mh: vol.map(function (v, i) { return Math.round(v * mhPerUnit[i]); }),
    cScheduling: Math.round(180000 * variance),
    cSetups: Math.round(220000 * variance),
    cParts: Math.round(150000 * variance),
    cMachine: Math.round(120000 * variance)
  };
  data.totalOH = data.cScheduling + data.cSetups + data.cParts + data.cMachine;
  return data;
}

/** Computes the traditional (plant-wide) and ABC solutions from a dataset. */
function calculateSolutions(d) {
  var sol = {};

  var totalDlCost = d.vol.reduce(function (acc, v, i) {
    return acc + (v * d.dl[i] * d.dlRate);
  }, 0);
  sol.p1Rate = (d.totalOH / totalDlCost) * 100;
  sol.p1AllocatedOh = d.dl.map(function (dlh) { return dlh * d.dlRate * (sol.p1Rate / 100); });
  sol.p1UnitCost = d.dm.map(function (dmc, i) { return dmc + (d.dl[i] * d.dlRate) + sol.p1AllocatedOh[i]; });
  sol.p1Prices = sol.p1UnitCost.map(function (uc) { return uc * d.markup; });

  var tRuns = d.runs.reduce(function (a, b) { return a + b; }, 0);
  var tSu = d.suHours.reduce(function (a, b) { return a + b; }, 0);
  var tPts = d.parts.reduce(function (a, b) { return a + b; }, 0);
  var tMh = d.mh.reduce(function (a, b) { return a + b; }, 0);

  sol.rSched = d.cScheduling / tRuns;
  sol.rSetup = d.cSetups / tSu;
  sol.rParts = d.cParts / tPts;
  sol.rMach = d.cMachine / tMh;

  sol.aSch = d.runs.map(function (r) { return r * sol.rSched; });
  sol.aSu = d.suHours.map(function (sh) { return sh * sol.rSetup; });
  sol.aPts = d.parts.map(function (p) { return p * sol.rParts; });
  sol.aMach = d.mh.map(function (m) { return m * sol.rMach; });

  sol.abcUnitCost = d.vol.map(function (v, i) {
    var tot = sol.aSch[i] + sol.aSu[i] + sol.aPts[i] + sol.aMach[i];
    return d.dm[i] + (d.dl[i] * d.dlRate) + (tot / v);
  });
  sol.abcPrices = sol.abcUnitCost.map(function (uc) { return uc * d.markup; });

  // "True margin" = the price the market is actually being charged
  // (which in reality does not change just because the accounting method
  // does) minus the ABC-derived true cost. This is what "most profitable"
  // and "which product deserves investment" should be judged against.
  sol.trueMargin = sol.p1Prices.map(function (p, i) { return p - sol.abcUnitCost[i]; });

  return sol;
}

var PRODUCT_NAMES = ['Blue', 'Black', 'Red', 'Purple'];

/**
 * PHASE 5 ASSUMPTIONS -- "avoidable" vs "committed" cost.
 * These fractions represent, for each activity pool, the portion of the
 * cost that would genuinely disappear in the short run if all volume for
 * one product line vanished. The rest is a step-fixed / committed capacity
 * cost (staff, tooling, floor space) that persists until management
 * actively resizes it. These are documented, named business-rule constants
 * -- not implied by the random dataset -- because in the real world this
 * split comes from management judgment about capacity, not from the
 * accounting system itself. An instructor extending this simulation should
 * feel free to tune these, which is exactly why they're named constants in
 * one place rather than scattered magic numbers.
 */
var AVOIDABLE_FRACTIONS = {
  scheduling: 0.15, // mostly a committed planning/logistics capability
  setups: 0.20,     // changeover capability & tooling largely stays in place
  parts: 0.80,      // parts administration cost tracks the number of parts actually bought/handled -- mostly avoidable
  machine: 0.50      // half depreciation (committed), half power/consumables (avoidable)
};

/** Customer order-pattern assumptions for the Phase 5b "customer lens" case.
 *  Applied to whichever product ABC identifies as the most profitable, to
 *  show that even the "winning" product can hide a loss-making customer. */
var CUSTOMER_SHARES = {
  alpha: { volShare: 0.70, runShare: 0.20, setupShare: 0.15, partsShare: 0.40 }, // large, infrequent, predictable orders
  beta: { volShare: 0.30, runShare: 0.80, setupShare: 0.85, partsShare: 0.60 }  // small, frequent, high-touch rush orders
};

/**
 * Phase 5: capacity & committed-cost analysis, computed fresh from the
 * stored dataset/solution every time it's needed (never trusted from the
 * client).
 */
function computeCapacityAnalysis(d, sol, specialtyIdx) {
  var totalAllocSpecialty = sol.aSch[specialtyIdx] + sol.aSu[specialtyIdx] + sol.aPts[specialtyIdx] + sol.aMach[specialtyIdx];
  var avoidableAllocSpecialty = sol.aSch[specialtyIdx] * AVOIDABLE_FRACTIONS.scheduling
    + sol.aSu[specialtyIdx] * AVOIDABLE_FRACTIONS.setups
    + sol.aPts[specialtyIdx] * AVOIDABLE_FRACTIONS.parts
    + sol.aMach[specialtyIdx] * AVOIDABLE_FRACTIONS.machine;
  var avoidablePct = (avoidableAllocSpecialty / totalAllocSpecialty) * 100;

  var variableUnitCost = d.vol.map(function (v, i) {
    var avoidableAlloc = sol.aSch[i] * AVOIDABLE_FRACTIONS.scheduling
      + sol.aSu[i] * AVOIDABLE_FRACTIONS.setups
      + sol.aPts[i] * AVOIDABLE_FRACTIONS.parts
      + sol.aMach[i] * AVOIDABLE_FRACTIONS.machine;
    return d.dm[i] + (d.dl[i] * d.dlRate) + (avoidableAlloc / v);
  });

  var mhPerUnit = d.vol.map(function (v, i) { return d.mh[i] / v; });
  var contributionPerMH = sol.p1Prices.map(function (price, i) {
    return (price - variableUnitCost[i]) / mhPerUnit[i];
  });
  var throughputRanking = PRODUCT_NAMES.slice().sort(function (a, b) {
    return contributionPerMH[PRODUCT_NAMES.indexOf(b)] - contributionPerMH[PRODUCT_NAMES.indexOf(a)];
  });

  var classification = {};
  Object.keys(AVOIDABLE_FRACTIONS).forEach(function (k) {
    classification[k] = AVOIDABLE_FRACTIONS[k] > 0.5 ? 'Avoidable' : 'Committed';
  });

  // Specialty product's contribution margin on a purely variable/avoidable
  // basis. If this is still positive, discontinuing the line entirely
  // throws away a contribution that WAS covering part of already-committed
  // capacity -- the nuanced, "right-size instead of kill" case. If it's
  // negative, the product doesn't even cover its own avoidable cost and a
  // full exit is genuinely justified.
  var specialtyContributionMargin = sol.p1Prices[specialtyIdx] - variableUnitCost[specialtyIdx];

  return {
    avoidablePct: avoidablePct,
    variableUnitCost: variableUnitCost,
    contributionPerMH: contributionPerMH,
    throughputRanking: throughputRanking,
    classification: classification,
    specialtyContributionMargin: specialtyContributionMargin
  };
}

/**
 * Phase 5b: customer-level cost distortion for whichever product ABC
 * identifies as most profitable. Reuses the SAME pool rates already
 * computed for the product-level analysis -- the point is that identical
 * per-unit ABC math, applied at the customer level, reveals a second layer
 * of distortion traditional (product-only) ABC reporting misses.
 */
function computeCustomerAnalysis(d, sol, winnerIdx) {
  var price = sol.p1Prices[winnerIdx];
  var vol = d.vol[winnerIdx], runs = d.runs[winnerIdx], su = d.suHours[winnerIdx],
    parts = d.parts[winnerIdx], mh = d.mh[winnerIdx];

  function build(shares) {
    var custVol = vol * shares.volShare;
    var custRuns = runs * shares.runShare;
    var custSu = su * shares.setupShare;
    var custParts = parts * shares.partsShare;
    var custMh = mh * shares.volShare; // machine time tracks volume produced for this customer
    var revenue = price * custVol;
    var dmDlCost = (d.dm[winnerIdx] + (d.dl[winnerIdx] * d.dlRate)) * custVol;
    var allocatedOverhead = (custRuns * sol.rSched) + (custSu * sol.rSetup) + (custParts * sol.rParts) + (custMh * sol.rMach);
    var totalCost = dmDlCost + allocatedOverhead;
    var margin = revenue - totalCost;
    return {
      volumeUnits: custVol, runs: custRuns, setupHours: custSu, partsLines: custParts,
      revenue: revenue, allocatedOverhead: allocatedOverhead, totalCost: totalCost,
      margin: margin, marginPerUnit: margin / custVol
    };
  }

  var alpha = build(CUSTOMER_SHARES.alpha);
  var beta = build(CUSTOMER_SHARES.beta);
  var lessProfitable = (beta.marginPerUnit < alpha.marginPerUnit) ? 'Beta' : 'Alpha';
  var marginGapPerUnit = Math.abs(alpha.marginPerUnit - beta.marginPerUnit);

  return {
    winnerProduct: PRODUCT_NAMES[winnerIdx], alpha: alpha, beta: beta,
    lessProfitable: lessProfitable, marginGapPerUnit: marginGapPerUnit
  };
}

/**
 * Derives the correct answers for the pre/post assessment questions and the
 * strategic dilemma DIRECTLY from the computed data, instead of hardcoding
 * literals like 'Blue' that can silently drift out of sync with the model.
 *
 * NOTE ON A BUG WE FOUND AND FIXED: in this dataset, direct materials and
 * direct labor hours per unit are identical for all four products, and the
 * plant-wide overhead rate is applied to direct labor hours -- which are
 * also identical per unit across products. That means the TRADITIONAL
 * unit cost is mathematically IDENTICAL for all four products, every
 * single time (that's the whole "profitability illusion" teaching point).
 * The original tool's answer key marked a specific product ('Blue') as
 * correct for the pre-ABC "most profitable" and "who deserves investment"
 * questions -- which does not match the data it generated. The correct
 * answer to those pre-ABC questions is "Equal" / "All" (uniform), which is
 * in fact an option already present in the UI. This function fixes that.
 */
function deriveCorrectAnswers(d, sol, opts) {
  opts = opts || {};
  var EPS = 0.005; // rupees; traditional costs are algebraically identical, this just guards float noise

  var traditionalAllEqual = sol.p1UnitCost.every(function (uc) {
    return Math.abs(uc - sol.p1UnitCost[0]) < EPS;
  });

  // --- Traditional (pre-ABC) correct answers ---
  var mostProfitableTraditional = traditionalAllEqual ? 'Equal' : PRODUCT_NAMES[argMin(sol.p1UnitCost)];
  var rankingTraditional = traditionalAllEqual
    ? ['Equal', 'Equal', 'Equal', 'Equal']
    : rankDescendingByProfitProxy(sol.p1UnitCost);
  var capitalInvestmentTraditional = traditionalAllEqual ? 'All' : PRODUCT_NAMES[argMin(sol.p1UnitCost)];

  // --- ABC (post) correct answers, based on true margin ---
  var mostProfitableABC = PRODUCT_NAMES[argMax(sol.trueMargin)];
  var rankingABC = PRODUCT_NAMES.slice().sort(function (a, b) {
    return sol.trueMargin[PRODUCT_NAMES.indexOf(b)] - sol.trueMargin[PRODUCT_NAMES.indexOf(a)];
  });
  var capitalInvestmentABC = PRODUCT_NAMES[argMax(sol.trueMargin)];

  // Expansion recommendation: data-driven, not a bare literal. We flag
  // "don't expand" when the spread between the best and worst true margin
  // is large relative to price -- i.e. some product line is quietly
  // destroying value even though traditional costing hid it. The threshold
  // is a named, documented business rule (not a magic string) so it can be
  // tuned or audited.
  var marginSpread = Math.max.apply(null, sol.trueMargin) - Math.min.apply(null, sol.trueMargin);
  var avgPrice = sol.p1Prices.reduce(function (a, b) { return a + b; }, 0) / sol.p1Prices.length;
  var EXPANSION_RISK_THRESHOLD = 0.5; // if margin spread exceeds 50% of avg price, expansion is unsafe
  var expandRecommendation = (marginSpread / avgPrice > EXPANSION_RISK_THRESHOLD) ? 'NO' : 'YES';

  // The pre-ABC question asks the SAME expand/no-expand question before the
  // student has seen ABC data. We score both pre and post against the same
  // ground truth (that's what makes "Learning Gain" meaningful): the
  // correct answer doesn't change, only whether the student can see it yet.
  var expandTraditional = expandRecommendation;
  var expandABC = expandRecommendation;

  var specialtyIdx = argMin(d.vol);
  var winnerIdx = argMax(sol.trueMargin);
  var capacity = computeCapacityAnalysis(d, sol, specialtyIdx);
  var customer = computeCustomerAnalysis(d, sol, winnerIdx);

  // Dilemma (3-way, data-driven):
  //   A: keep expanding blindly -- wrong whenever the specialty line is
  //      genuinely undercosted by traditional accounting.
  //   B: exit the line entirely -- only correct if the line doesn't even
  //      cover its own avoidable/variable cost (negative contribution
  //      margin on a short-run basis).
  //   C: right-size (keep it, but with pricing/MOQ changes to cover its
  //      true complexity cost) -- correct when the line IS undercosted by
  //      traditional accounting, but STILL clears a positive contribution
  //      margin once only the genuinely avoidable cost is counted, i.e.
  //      it's covering part of already-committed capacity and a full exit
  //      would strand that cost rather than eliminate it.
  var isUndercostedTraditionally = sol.abcUnitCost[specialtyIdx] > sol.p1UnitCost[specialtyIdx];
  var dilemmaCorrect;
  if (!isUndercostedTraditionally) {
    dilemmaCorrect = 'A';
  } else if (capacity.specialtyContributionMargin <= 0) {
    dilemmaCorrect = 'B';
  } else {
    dilemmaCorrect = 'C';
  }

  return {
    traditional: {
      mostProfitable: mostProfitableTraditional,
      ranking: rankingTraditional,
      capitalInvestment: capitalInvestmentTraditional,
      expand: expandTraditional
    },
    abc: {
      mostProfitable: mostProfitableABC,
      ranking: rankingABC,
      capitalInvestment: capitalInvestmentABC,
      expand: expandABC
    },
    dilemma: dilemmaCorrect,
    specialtyProductIndex: specialtyIdx,
    specialtyProductName: PRODUCT_NAMES[specialtyIdx],
    winnerProductIndex: winnerIdx,
    winnerProductName: PRODUCT_NAMES[winnerIdx],
    capacity: capacity,
    customer: customer
  };
}

function argMin(arr) {
  var idx = 0;
  for (var i = 1; i < arr.length; i++) if (arr[i] < arr[idx]) idx = i;
  return idx;
}
function argMax(arr) {
  var idx = 0;
  for (var i = 1; i < arr.length; i++) if (arr[i] > arr[idx]) idx = i;
  return idx;
}
function rankDescendingByProfitProxy(unitCostArr) {
  // Lower unit cost under an unchanged markup = higher absolute margin.
  return PRODUCT_NAMES.slice().sort(function (a, b) {
    return unitCostArr[PRODUCT_NAMES.indexOf(b)] - unitCostArr[PRODUCT_NAMES.indexOf(a)];
  });
}

/**
 * Scores a 4-question decision block (25% each), mirroring the original
 * tool's grading resolution, but against dynamically derived correct
 * answers instead of hardcoded literals.
 * @param {{q1:string, ranking:string[4], q3:string, q4:string}} answers
 * @param {{mostProfitable:string, ranking:string[4], capitalInvestment:string, expand:string}} correct
 */
function scoreDecisionBlock(answers, correct) {
  var acc = 0;
  var detail = {};
  detail.q1 = (answers.q1 === correct.mostProfitable);
  detail.q2 = Array.isArray(answers.ranking) && answers.ranking.length === 4 &&
    answers.ranking.every(function (v, i) { return v === correct.ranking[i]; });
  detail.q3 = (answers.q3 === correct.capitalInvestment);
  detail.q4 = (answers.q4 === correct.expand);
  if (detail.q1) acc += 25;
  if (detail.q2) acc += 25;
  if (detail.q3) acc += 25;
  if (detail.q4) acc += 25;
  return { accuracy: acc, detail: detail };
}

/**
 * Scores Phase 5 (capacity & committed cost): 4 classification dropdowns
 * (2 pts each = 8), one numeric "% actually avoidable" estimate (4 pts,
 * within a 7-percentage-point tolerance), and one 4-way throughput ranking
 * (3 pts, exact match). Max 15.
 * @param {{classification:Object, reductionEstimate:number, throughputRanking:string[4]}} answers
 */
function scorePhase5(answers, capacity) {
  var detail = {};
  var score = 0;
  var POOL_KEYS = ['scheduling', 'setups', 'parts', 'machine'];
  POOL_KEYS.forEach(function (k) {
    var correct = answers.classification && answers.classification[k] === capacity.classification[k];
    detail['classification_' + k] = !!correct;
    if (correct) score += 2;
  });
  var reductionOk = typeof answers.reductionEstimate === 'number' &&
    Math.abs(answers.reductionEstimate - capacity.avoidablePct) <= 7;
  detail.reductionEstimate = reductionOk;
  if (reductionOk) score += 4;

  var rankingOk = Array.isArray(answers.throughputRanking) && answers.throughputRanking.length === 4 &&
    answers.throughputRanking.every(function (v, i) { return v === capacity.throughputRanking[i]; });
  detail.throughputRanking = rankingOk;
  if (rankingOk) score += 3;

  return { score: score, maxScore: 15, detail: detail };
}

/**
 * Scores the customer-lens question: identifying the less-profitable
 * customer (7 pts) and estimating the per-unit margin gap between them
 * (8 pts, within 25% relative tolerance + a small absolute buffer to avoid
 * penalizing reasonable rounding). Max 15.
 * @param {{lessProfitableCustomer:string, marginGapEstimate:number}} answers
 */
function scoreCustomerLens(answers, customer) {
  var detail = {};
  var score = 0;
  detail.identifiedCustomer = (answers.lessProfitableCustomer === customer.lessProfitable);
  if (detail.identifiedCustomer) score += 7;

  var tolerance = (customer.marginGapPerUnit * 0.25) + 2;
  var gapOk = typeof answers.marginGapEstimate === 'number' &&
    Math.abs(answers.marginGapEstimate - customer.marginGapPerUnit) <= tolerance;
  detail.marginGapEstimate = gapOk;
  if (gapOk) score += 8;

  return { score: score, maxScore: 15, detail: detail };
}

// Export for Node (test harness). Apps Script ignores `module` (undefined
// there), so this has zero effect when the file runs inside Apps Script.
if (typeof module !== 'undefined') {
  module.exports = {
    mulberry32: mulberry32,
    hashStringToSeed: hashStringToSeed,
    generateDataset: generateDataset,
    calculateSolutions: calculateSolutions,
    deriveCorrectAnswers: deriveCorrectAnswers,
    scoreDecisionBlock: scoreDecisionBlock,
    computeCapacityAnalysis: computeCapacityAnalysis,
    computeCustomerAnalysis: computeCustomerAnalysis,
    scorePhase5: scorePhase5,
    scoreCustomerLens: scoreCustomerLens,
    AVOIDABLE_FRACTIONS: AVOIDABLE_FRACTIONS,
    CUSTOMER_SHARES: CUSTOMER_SHARES,
    PRODUCT_NAMES: PRODUCT_NAMES
  };
}
