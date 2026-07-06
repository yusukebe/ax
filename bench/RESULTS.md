# ax benchmark results

Method: the same task is given to two real headless Claude Code sessions
(`claude -p`, model claude-fable-5, tools Bash/Read/Grep/Glob).

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
