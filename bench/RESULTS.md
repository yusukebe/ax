# ax benchmark results

**How to read this file**: it is a chronological, unedited lab log — losses,
dead ends and variance warnings included. Early sections benchmark the
multi-tool era of ax (`ax html/json/text/stats` subcommands, `--like`); those
commands now live on the [`toolkit`](https://github.com/yusukebe/ax/tree/toolkit)
and [`like`](https://github.com/yusukebe/ax/tree/like) branches, not on main.
Everything from "Single-command ax" onward benchmarks the current
single-command ax.
The numbers on [the website](https://ax.yusuke.run) come from the
tool-warm suite at the bottom.

Method: the same task is given to two real headless Claude Code sessions
(`claude -p`, model claude-fable-5 unless stated, tools Bash/Read/Grep/Glob).

- **A (baseline)**: no knowledge of ax.
- **B (ax)**: the ax skill is in context (as it would be after `npx skills add`).

Metrics come from the CLI's `--output-format json` (duration, turns, token
usage, cost). Every answer was graded against ground truth computed
independently. All runs are n=1 — treat small deltas as noise.

## Results by command

### ax html — scraping (ax's home turf)

| scenario                         | A           | B           | verdict          |
| -------------------------------- | ----------- | ----------- | ---------------- |
| clean page, 300 rows + aggregate | $0.88 / 37s | $0.57 / 32s | **ax −35% cost** |
| two pages with markup drift      | $1.48 / 66s | $0.94 / 95s | **ax −36% cost** |

Baseline writes regex-on-HTML python; drift forces it to write 2.4× more
code. ax's CSS selectors don't notice the drift.

### ax json — 92KB API export

| iteration                      | A (python3 -c) | B               | verdict                  |
| ------------------------------ | -------------- | --------------- | ------------------------ |
| before `--shape/--pick/--freq` | $0.47 / 26s    | $0.58 / 40s     | ax +24% (loss)           |
| after                          | $0.47 / 26s    | **$0.41 / 19s** | **ax −13%, fastest run** |

### ax text — 381KB log, grep-shaped tasks

| iteration | A (grep\|sort\|uniq) | B           | verdict       |
| --------- | -------------------- | ----------- | ------------- |
| before    | $0.40 / 24s          | $0.76 / 64s | grep +91%     |
| after     | $0.40 / 24s          | $0.61 / 49s | **grep wins** |

Conceded: for plain line-grepping, grep is unbeatable. The skill now says so.

### composite incident investigation (5 questions: percentiles, means, group-by)

| iteration                      | cost / time / turns | what happened                                                     |
| ------------------------------ | ------------------- | ----------------------------------------------------------------- |
| A (python heredoc ×2)          | $0.62 / 51s / 5     | baseline                                                          |
| B, first run                   | $0.97 / 108s / 16   | **found a real ax bug** (silent --grep/--extract non-composition) |
| B, after bug fix               | $1.29 / 166s / 12   | over-verification spiral (cheap probes → more probing)            |
| B, skill-in-context            | $1.63 / 208s / 26   | found 2 more UX gaps (capture groups, quoting)                    |
| B, after UX fixes              | $0.84 / 87s / 13    | friction gone, but one command per turn                           |
| **B, few-shot batching skill** | **$0.57 / 47s / 4** | **beats A on every metric**                                       |

### 10-question "workday" (HTML + JSON + log mixed)

|                     | A               | B               |
| ------------------- | --------------- | --------------- |
| cost / time / turns | $0.70 / 52s / 4 | $0.75 / 64s / 5 |

A tie. Python batches a whole multi-part question into one script very
effectively. The difference is _what got written_: A hand-implemented
percentile math (two methods, ~1.3KB of python); B's first move was

    ax html sample.html --outline; ax json users.json --shape; ax text app.log --head 5

— three unknown files understood in one line — and `| ax stats` replaced the
percentile implementation.

### Big-file probe (~10MB nested JSON, schema unknown)

|                     | A                   | B               |
| ------------------- | ------------------- | --------------- |
| cost / time / turns | **$0.47 / 32s / 3** | $1.17 / 60s / 6 |

Hypothesis killed: file size doesn't hurt python (it processes out-of-context).
A wins. Kept for honesty.

### The model gradient (composite incident task, per model)

| agent model | A: baseline       | B: with ax           | ax effect                |
| ----------- | ----------------- | -------------------- | ------------------------ |
| Fable 5     | $0.62 / 5 turns   | $0.57 / 4 turns      | −8%                      |
| Opus 4.8    | $0.309 / 5 turns  | **$0.224 / 3 turns** | **−28% cost, −18% time** |
| Sonnet 5    | $0.238 / 7 turns  | **$0.204 / 5 turns** | **−14% cost, −31% time** |
| Haiku 4.5   | $0.178 / 14 turns | **$0.070 / 3 turns** | **−61% cost**            |

All six runs answered every question correctly. The weaker the model, the
more ax helps: without ax, Haiku needed 14 turns of trial and error; with ax
it followed the skill's 3-call pattern.

**The headline**: Haiku + ax ($0.07) produced the same correct investigation
as Fable 5 alone ($0.62) — **9× cheaper** — and beat Sonnet alone ($0.24) by
3.4×. ax lets you hand frontier-model work to a budget model.

### Semantic search (--like) — measured honestly, not benched as a win

On a 5,000-line haystack of textually-unique support messages (combinatorial +
LLM-generated fillers, no statistical shortcuts), finding 40 deliberately
keyword-free shipping complaints:

- single query: recall 29/40 @top-100 (MiniLM), 34/40 @top-300
- realistic multi-net technique (5–8 differently-worded queries, unioned):
  **37/40 in a 252-line candidate set** — a 20× read reduction at 92.5% recall
- the last 3 complaints ("the van drove off while i was waving") are only
  findable by reading everything — that is judgment, i.e. agent work
- bge-small-en-v1.5 (CLS pooling + query prefix) did not beat MiniLM here

Conclusion baked into the skill: --like is a high-recall funnel for
find-some/browse tasks, not an oracle for exhaustive counts. We did not run
an A/B where the ax side would report a wrong exact count.

### Warm (steady-state) measurement — the deployment-realistic condition

All benches above are cold starts: the agent meets ax for the first time,
while python/jq enjoy a training-data moat. Real deployment is warm — the
skill is installed and the agent used ax minutes ago. Two-phase design:
phase 1 (small task) warms the session; phase 2 (the 5-question incident
investigation) is measured via `claude -p --resume` (Opus, both correct):

| phase 2 (marginal) | A: baseline | B: ax (warm) | delta    |
| ------------------ | ----------- | ------------ | -------- |
| cost               | $0.180      | **$0.103**   | **−43%** |
| time               | 56.7s       | **26.8s**    | **−53%** |
| turns              | 5           | **3**        | −2       |

The warmup phase itself also went to B ($0.150 vs $0.204 — including the
skill tokens). Whole session: −34%. Against cold A ($0.309): −67%.

**ax gets cheaper the longer an agent works with it; throwaway scripts
never do — every new question is a new script.**

## Correctness

Both conditions answered every question correctly in every round (15+ runs).
B additionally caught a truncation footgun via ax's stderr note in one run,
and one round of grading exposed a bug in our own ground truth (an empty
line counted as 0 by the old `ax stats`).

## What the benchmark changed in ax

Every loss produced a fix:

- `--shape`, `--pick`, `--freq`, `--tsv`, `--budget` (json/yaml)
- `ax stats` (percentiles/means — the exact ask that sends agents to python)
- NDJSON auto-parsing in `ax json`
- BUG: `--extract` now composes with `--grep` (was silently extracting from
  all lines — the agent noticed wrong numbers, lost trust in the tool, and
  redid everything with grep/awk; silent-wrong is the most expensive failure
  mode an agent tool can have)
- `--extract` capture-group semantics; `ax stats` accepts unit suffixes
- stderr hint when `--where` matches 0 rows (shell-quoting accidents)
- agent-context slimmed ~1.4k → ~0.7k tokens; skill teaches 3-call batching
  with a worked example

## Honest summary

- Structure-heavy tasks (HTML, JSON, filter/project/aggregate): **ax wins,
  13–36% cheaper**, and is drift-proof where regex breaks.
- Plain grep counting: grep wins; ax defers. Big files: python doesn't care;
  no ax advantage.
- Multi-part analysis: parity on frontier models; ax needs no hand-written
  math and keeps raw bytes out of the context window.
- **The multiplier lives on budget models**: ax's benefit is inversely
  proportional to model strength (−8% on Fable, −14% on Sonnet, −61% on
  Haiku). Haiku + ax matches frontier-alone output at **1/9 the cost**.

## Single-command ax (the AI-era curl refocus) — re-measured

After the refocus (`ax <url|file> [selector]`, fetch cache, rewritten skill),
the three web-arena benches re-run cold on Opus (baselines unchanged):

| bench            | A: baseline  | old multi-command B        | **single-command B**                    |
| ---------------- | ------------ | -------------------------- | --------------------------------------- |
| clean extraction | $0.267 / 40s | $0.262 / 29s               | $0.250 / **28.7s**                      |
| markup drift     | $0.664 / 42s | $0.35–0.55 (high variance) | **$0.338 / 58s (−49%)**                 |
| live website     | $0.332 / 41s | $0.372 / 76s               | **$0.303 / 35.6s — first live-web win** |

All correct. The focused surface + fetch cache + tighter skill closed the
live-web gap that the toolkit era never won.

### Warm web-arena runs (both sides warmed on a related page)

| phase 2      | A warm       | B warm           |
| ------------ | ------------ | ---------------- |
| live website | $0.277 / 55s | **$0.267 / 49s** |
| markup drift | $0.303 / 70s | **$0.285 / 66s** |

Warmth helps _both_ sides: A's drift cost fell $0.664 → $0.303 because the
warmup taught it the page structure (our warmup page shares the fixture's
markup — a deliberate but structure-leaking design). Verdict: ax wins every
web bench cold and warm; warm margins are slim because experience is the
great equalizer on single-structure tasks. The big warm win (−43%) lives on
multi-step investigations.

### Haiku drift + row-stats note

Haiku 4.5, markup-drift task, both correct: A $0.093 / 26s vs B **$0.051 /
21.2s (−46%)**. Also shipped: --row/--table now print `N rows extracted` +
empty-field counts on stderr, killing the verification-probe habit at the
tool level.

### TSV-default + row-stats era (re-run, Opus cold)

| bench         | A            | B                                                                           |
| ------------- | ------------ | --------------------------------------------------------------------------- |
| markup drift  | $0.664       | **$0.282 (−58%)** — the agent quoted the row-stats note as its verification |
| live web      | $0.332 / 41s | **$0.295 / 39s**                                                            |
| clean extract | $0.267 / 40s | $0.354 / **21.6s / 3 turns** (fastest ever; cost up from an --all ingest)   |

TSV rows (57% fewer chars) + the `N rows extracted, no empty fields` note
removed the verification turns exactly as designed.

### Tool-warm, structure-cold (the "agent knows ax" condition)

Warmup on an unrelated page (products.html) teaches B the tool but teaches
A's python nothing; the measured drift phase pays no fresh skill tokens
(history is cache-read). Opus, both correct:

|              | python (tool-native) | ax (tool-warm)                            |
| ------------ | -------------------- | ----------------------------------------- |
| markup drift | $0.458 / 30s / 3t    | **$0.150 / 30s / 5t — ⅓ the cost (−67%)** |

The agent again cited the row-stats line as its verification.

### Tool-warm full set — variance warning

| tool-warm (n=1 each)    | python     | ax                                                 |
| ----------------------- | ---------- | -------------------------------------------------- |
| drift (Opus)            | $0.458     | **$0.150 (−67%)**                                  |
| drift (Haiku)           | $0.086     | $0.080 (−6%)                                       |
| live web (Opus)         | **$0.248** | $0.464 — B lost this run (12-turn generic-selector |
| spree; behavioral dice) |

Single warm runs swing hard. Before presenting a uniform "agent knows ax"
table, run n≥3 per cell and average. Kept here so we don't fool ourselves.

### Tool-warm suite, expanded (Opus, neutral warmup, all answers verified)

Clean extraction (b2-lessons fixture, 60 B2 lessons):

|               | python (tool-native) | ax (tool-warm)                      |
| ------------- | -------------------- | ----------------------------------- |
| clean extract | $0.296 / 23.9s / 3t  | **$0.104 / 13.8s / 3t (−65% cost)** |

Live web (elllo.org, real internet, 50 lessons + decoy divs), n=3:

| sample     | python           | ax                                        |
| ---------- | ---------------- | ----------------------------------------- |
| 1          | **$0.248 / 34s** | $0.464 (generic-selector spree; recorded) |
| 2          | $0.264 / 45s     | **$0.191 / 36s (−28%)**                   |
| 3          | $0.189 / 32s     | $0.190 / 35s (tie)                        |
| **median** | $0.248           | **$0.191 (−23%)**                         |

All six runs answered correctly (50 lessons, mobilelist selector, correct
first-three hrefs). Live web is the noisiest arena: ax wins the median but
one sample lost outright. Reported as median-of-3, loss included.

**Tool-warm scoreboard (Opus, all verified correct):** drift −67%, clean
extract −65%, live web −23% (median of 3). These are the site numbers.

## JSON-envelope continuation (Sonnet 5, n=3 per condition)

### Method

A deterministic 120-row HTML fixture was generated from an independent fixed seed.
Each run used budget 600, while ground truth remained in the parent process.
Conformance explicitly taught continuation; Adoption compared the same natural task
with the full Skill versus a runtime-only continuation-guidance ablation.
Raw session records stayed outside the repository.

### Preliminary stopped attempts

Three earlier formal matrix invocations were stopped by gradability gates and excluded from the reported sample.
They exposed fixture-metadata preflights, compound or interpreter-wrapped ax commands,
and terminal responses containing text outside the required JSON object.
The methodology was then changed to require standalone ax calls, prohibit all non-ax
fixture access, enforce a JSON-only response, and tighten access auditing before the
final matrix was collected. A post-run review further replaced permissive non-ax
handling with a conservative allowlist; regrading the retained runs did not change
their gradability or published scores. These are adaptive, exploratory results rather
than a preregistered confirmatory evaluation.

### Per-run results

| Run | Condition        | Exact | Protocol | Envelope | Pages | Turns | Duration (s) |  Input | Output | Cache create | Cache read |   Cost |
| --: | ---------------- | :---: | -------- | :------: | ----: | ----: | -----------: | -----: | -----: | -----------: | ---------: | -----: |
|   1 | Conformance      |  no   | pass     |    —     |     5 |     8 |        170.5 |  57346 |   9746 |            0 |     314752 | $0.413 |
|   2 | Adoption guided  |  no   | fail     |    no    |     3 |     6 |        370.2 |  14794 |  23254 |            0 |     290048 | $0.480 |
|   3 | Adoption ablated |  no   | fail     |    no    |     6 |    10 |        630.9 |  72592 |  32273 |            0 |     503680 | $0.853 |
|   4 | Conformance      |  yes  | pass     |    —     |     5 |     8 |        167.6 |  56400 |   7907 |            0 |     360832 | $0.396 |
|   5 | Adoption guided  |  no   | pass     |   yes    |     5 |     7 |        199.8 |  20118 |  10369 |            0 |     358784 | $0.324 |
|   6 | Adoption ablated |  no   | fail     |    no    |     3 |     5 |        747.2 |  86911 |  43130 |            0 |     289280 | $0.994 |
|   7 | Conformance      |  yes  | pass     |    —     |     5 |     8 |        153.6 |  18545 |   7222 |            0 |     398464 | $0.284 |
|   8 | Adoption guided  |  no   | pass     |   yes    |     5 |     8 |        413.9 |  33677 |  22772 |            0 |     496384 | $0.592 |
|   9 | Adoption ablated |  no   | fail     |    no    |     6 |     8 |        609.2 | 102120 |  29857 |            0 |     462464 | $0.893 |

### Aggregate

| Condition        | Exact | Protocol pass | Envelope adoption | Median turns | Median duration (s) | Median input | Median output | Median cost |
| ---------------- | ----: | ------------: | ----------------: | -----------: | ------------------: | -----------: | ------------: | ----------: |
| Conformance      |   2/3 |           3/3 |                 — |            8 |               167.6 |        56400 |          7907 |      $0.396 |
| Adoption guided  |   0/3 |           2/3 |               2/3 |            7 |               370.2 |        20118 |         22772 |      $0.480 |
| Adoption ablated |   0/3 |           0/3 |               0/3 |            8 |               630.9 |        86911 |         32273 |      $0.893 |

### Observed failure modes

Across 4 Adoption runs without envelope adoption, 4 used `offset-without-envelope`; 4 failed protocol grading.
Among 7 non-exact answers, 4 were schema-invalid. Among the 3 schema-valid non-exact answers, 0 had missing records, 3 had unexpected records, 0 had duplicate records, 0 had ordering errors, and 0 had field mismatches. Categories can overlap.

### Interpretation and limitations

Answer correctness, continuation-protocol correctness, and active envelope adoption
are reported separately. Each condition has only three runs on one deterministic
fixture and one model, so differences are descriptive rather than general claims.
Claude Code event structure may also change across CLI versions.
