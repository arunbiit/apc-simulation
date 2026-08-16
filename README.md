# Active Pen Company — Revised ABC Simulation

This is a security- and validity-focused rewrite of the original single-file
tool. The biggest structural change: **grading logic now lives on the
server**, not in the browser. Everything else (consent, validation
completeness, reproducibility, submission reliability, tests) follows from
that.

## Files

```
backend/CalcEngine.gs   Pure calculation engine (dataset generation, ABC
                        math, Phase 5 capacity/committed-cost analysis,
                        customer-lens analysis, correct-answer derivation).
                        No Apps Script or browser APIs -- this is what
                        makes it testable in plain Node.
backend/Code.gs         Apps Script web app: sessions, validation, hints,
                        overrides, final scoring, Sheet-backed storage.
frontend/index.html     The student-facing simulation. Contains no
                        answer key -- only calls the backend and renders
                        its responses. BACKEND_API_URL is already pointed
                        at the deployed web app; redeploy and update it if
                        you create a fresh Apps Script deployment.
tests/test-calc-engine.js
                        Node unit tests for the math, loading the REAL
                        CalcEngine.gs (not a copy).
tests/test-backend-integration.js
                        Full session-lifecycle test against the REAL
                        Code.gs, with Apps Script globals mocked.
tests/test-frontend-e2e.js
                        Headless click-through of the REAL index.html in
                        jsdom. Requires `npm install jsdom` once.
```

## Deploy it

1. Create a new Google Sheet (this becomes your session/gradebook store).
2. **Extensions → Apps Script**. Delete the default `Code.gs` stub, then
   create two script files named exactly `CalcEngine.gs` and `Code.gs`,
   and paste in the contents from `backend/`.
3. (Optional) **Project Settings → Script Properties**, add:
   - `INSTRUCTOR_ROLL` — a roll number that triggers instructor/demo mode
     (defaults to `ADMIN-000` if not set).
   - `RESEARCH_SALT` — any random string, used to generate one-way
     pseudonymous research IDs. Set this once and don't change it, or old
     and new research IDs for the same student won't match.
4. **Deploy → New deployment → Web app**. Execute as **Me**, access
   **Anyone**. Copy the `/exec` URL.
5. In `frontend/index.html`, replace `BACKEND_API_URL` with that URL.
6. Open `frontend/index.html` in a browser (or host it anywhere static
   files can be served) and test end-to-end with the instructor roll
   number first.
7. Run `node tests/test-calc-engine.js` any time you touch `CalcEngine.gs`.

## What changed, and why

**1. Server-side grading (was: client-side, inspectable answer key).**
`state.answers` no longer exists in the browser. `CalcEngine.gs` runs only
inside `Code.gs`, on the server. The client sends the student's inputs to
`validatePhase`/`submitFinal` and gets back a correct/incorrect verdict —
never the solved values, except through the explicitly-penalized `hint`
and `bypass` endpoints.

**2. Every field is now validated.** The original code checked the
overhead rate and unit cost in Phase 1, and the pool rates and final ABC
cost in Phase 2b, but silently skipped the allocated-overhead, target-price,
and per-driver allocation fields — meaning a student could type the right
final number without doing the intermediate work. All fields are now
checked server-side.

**3. Submission is a real HTTP round-trip, not `no-cors`.** The original
`fetch(..., { mode: "no-cors" })` made the response opaque — a server-side
script error would still show "success" to the student. The client now
uses a `text/plain` content type (keeps it a CORS "simple request", which
Apps Script can answer without a preflight) and reads a real JSON response.
If the request truly fails, the student gets an honest error and a
**downloadable JSON backup** of their answers, instead of "take a
screenshot."

**4. The raw generated dataset is stored with every submission.** Each
attempt's `seed` and the full generated dataset/solution are written to
the `Submissions` sheet, so any result can be reproduced and audited later
— not just referenced by an opaque 4-digit ID.

**5. Consent screen, separated from grading.** Screen 0 now requires an
"I understand this is graded" checkbox, and separately offers an optional
"I consent to research use of my anonymized data" checkbox. Submissions
include a one-way pseudonymous `researchId` (roll number + server-side
salt, hashed) so published analysis doesn't need to carry names or roll
numbers, and a `consentResearch` flag so non-consenting students' rows can
be filtered out of any research dataset while still being graded normally.

**6. Unit tests, against the real production file.** `tests/test-calc-engine.js`
loads `backend/CalcEngine.gs` itself (via Node's `vm` module) rather than a
hand-copied version, so the test can never silently drift out of sync with
what's actually deployed.

## A real bug this rewrite found and fixed

While deriving answers dynamically instead of hardcoding them, it became
clear the *original* answer key was wrong on two questions. In this model,
direct materials and direct labor hours per unit are identical across all
four products, and the plant-wide overhead rate is allocated on direct
labor hours — so the **traditional unit cost is mathematically identical
for all four products, every time**. That's the intended "profitability
illusion" teaching point. But the original hardcoded key expected the
literal string `'Blue'` as the correct pre-ABC "most profitable" answer
and capital-investment target, when the actually-correct answer (already
present as an option in the UI: "All variants look equally profitable") is
`'Equal'` / `'All'`. `deriveCorrectAnswers()` now computes this from the
data directly, and `tests/test-calc-engine.js` has a named regression test
(`"bug fix regression guard"`) so it can't quietly come back.

## New: critical-thinking challenge features

Six additions, on top of the security/validity rewrite:

**1. Phase 5 — "The Twist" (avoidable vs. committed cost).** After the
dashboard reveals which product is a hidden loss, students are told the
company discontinued it and overhead *didn't* drop by the full allocated
amount. They then classify each of the four activity pools as genuinely
short-run **avoidable** or **committed** capacity, estimate what percentage
of the specialty product's overhead would truly disappear, and rank all
four products by contribution-per-machine-hour under a stated capacity
constraint (deliberately requiring only the avoidable cost, since committed
cost is sunk regardless of mix). The avoidable/committed split is a named,
documented assumption (`AVOIDABLE_FRACTIONS` in `CalcEngine.gs`) — tune it
if your case needs different capacity economics.

**2. Phase 5b — the customer lens.** The SAME per-unit ABC rates already
computed are reapplied to two differently-behaved customers of whichever
product turned out most profitable (large predictable orders vs. small
frequent rush orders). Students identify which customer is secretly less
profitable and estimate the margin gap — showing that even the "winning"
product can hide a losing relationship.

**3. What-if sensitivity explorer.** An ungraded, purely client-side slider
on the dashboard screen lets students drag any product's volume up or down
and watch its ABC unit cost recompute live, using the rates they already
validated. Runs/setup-hours/parts are deliberately held fixed while volume
moves, so students can feel why batch-level costs don't scale down with
volume the way unit-level costs do.

**4. Capacity constraint reasoning** is folded into Phase 5's throughput
ranking (see #1) rather than a separate screen, since it depends on the
same avoidable/committed classification.

**5. A genuinely 3-way strategic dilemma.** The old binary "launch vs.
halt" choice is now launch / exit / **right-size** (keep the line but
reprice or set minimum order quantities to cover its true complexity cost).
Which of exit-vs-right-size is correct is derived from whether the
product's contribution margin is positive on an avoidable-cost-only basis
(see `deriveCorrectAnswers()` in `CalcEngine.gs`) — not hardcoded.

**6. "Defend your decision" rebuttal.** Before the reflection questions,
students face a canned counter-argument to their dilemma choice and must
write a short rebuttal. This is stored (`rebuttalResponse` column in
`Submissions`) for instructor review; it isn't machine-graded, by design —
open-ended defense of a position is exactly the kind of answer a rubric
can't reduce to a string match.

### Updated scoring model (still out of 100)

| Component | Points | Where |
|---|---|---|
| Base mechanical calculation (Phases 1, 2a, 2b) | 50 | minus penalties below |
| Strategic dilemma (3-way, correct choice) | 20 | Phase 3 |
| Phase 5 (classification + reduction estimate + throughput ranking) | 15 | Phase 5 |
| Customer lens (identify customer + estimate margin gap) | 15 | Phase 5b |
| Emergency override penalty | −10 each | any gated phase |
| Hint penalty | −3 each | Phases 1 & 2b |
| Failed validation attempt | −1 each, capped at −10 | any gated phase |

## Worked numbers (instructor/demo dataset, variance = 1.0)

```
totalDlCost = 400,000          p1Rate = 167.5%
p1UnitCost  = 15.70 for all four products (mathematically identical)
p1Price     = 21.98 for all
rSched = 1384.6154   rSetup = 550   rParts = 5555.5556   rMach = 12.766
abcUnitCost ≈ [12.2312 (Blue), 12.9113 (Black), 29.9128 (Red), 101.3426 (Purple)]
Phase 5: ~47.5% of Purple's allocated overhead is estimated avoidable;
         even on that basis its contribution margin is still negative,
         so the dilemma resolves to full exit (B) for this base dataset.
```
These are asserted directly in `tests/test-calc-engine.js`, so any change
to the model will fail loudly rather than silently drift.

## Tests (three layers)

```
node tests/test-calc-engine.js          # pure math, loads the real CalcEngine.gs
node tests/test-backend-integration.js  # full session lifecycle against the real Code.gs,
                                         # with Apps Script globals mocked
node tests/test-frontend-e2e.js         # headless click-through of the real index.html
                                         # in jsdom, wired to the mocked backend
                                         # (run `npm install jsdom` once first)
```
All three currently pass (48 / 30 / 28 checks respectively). None of these
files should be pasted into the Apps Script project — they're Node-only.

## Upgrading an existing deployment

You already have a live deployment with `Sessions`/`Submissions` sheets
from the previous version. This update changes both sheets' column layout
(new scoring components, `dilemmaChoice`/`dilemmaCorrect`, `rebuttalResponse`,
etc.). `getSheet()` only writes the header row when it **creates** a sheet
— it will NOT rewrite headers on a sheet that already exists, so simply
pasting the new code over the old will misalign every new row against the
old header row.

**Before redeploying, either:**
- Rename your existing `Sessions` and `Submissions` sheets (e.g. `Sessions_old`,
  `Submissions_old`) so the code creates fresh ones with the correct headers, or
- Manually delete those two sheets if you don't need the test data in them.

Then follow the normal deploy steps: paste in the updated `CalcEngine.gs`
and `Code.gs`, save, and push a **new deployment version** (Deploy → Manage
deployments → edit → New version → Deploy) — saving alone does not update
the live `/exec` URL.

## Known remaining limitations

- **Instructor mode is a convenience switch, not real auth.** Anyone who
  guesses/knows the instructor roll number can enter instructor mode
  (which skips grading, not security-sensitive data). If you need real
  auth, put this behind your institution's SSO/LMS instead of a magic
  roll number.
- **Google Sheets as a datastore is fine for classroom scale** (dozens to
  low hundreds of students) but will get slow with heavy concurrent
  traffic; `LockService` serializes writes, which caps throughput. For a
  large multi-section study, move `Sessions`/`Submissions` to a real
  database behind a small API instead.
- **This still doesn't stop a student from having someone else do the
  ABC math for them offline and typing in the answers** — no browser tool
  can fully prevent that. What it does prevent is the trivial "read the
  answer out of DevTools" shortcut and silently-ungraded fields.
- The dilemma's correct option is still tied to a fixed narrative (Option
  B references "the Purple pen" by name), so if you change which product
  is the lowest-volume/highest-complexity one, update the dilemma text —
  `deriveCorrectAnswers()` computes *which* option is correct dynamically,
  but doesn't rewrite the story text.
- **Phase 5's dilemma currently resolves to "full exit" (B), not the
  nuanced "right-size" (C), for the base dataset's magnitudes** — the
  model correctly supports C, but this particular product's distortion is
  severe enough that even avoidable-only cost exceeds price. If you want
  students to sometimes see C be correct, soften `AVOIDABLE_FRACTIONS` or
  the base cost-pool sizes for the lowest-volume product — see the comment
  above `deriveCorrectAnswers()` in `CalcEngine.gs`.

