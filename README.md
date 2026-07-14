# ax

**The AI-era curl: fetch, discover, extract. One command.**

ax is what a coding agent should reach for instead of `curl` piped into a throwaway parsing script. It fetches a page, helps the agent understand its structure, and extracts structured data — locally, deterministically, with output shaped for a context window.

```sh
ax https://api.example.com/users                     # curl parity — but never silent
ax https://example.com --outline                     # discover the page's structure
ax https://example.com '.item' --row 'title=a, href=a@href'
ax https://docs.example.com/guide --md --budget 800  # read docs as markdown
```

## Why

Coding agents do one web loop constantly: **fetch → understand → extract**. Today that means `curl` (which prints _nothing_ on an empty body), eyeballing raw HTML in the context window (thousands of tokens), and a regex-over-HTML script that breaks the moment the markup shifts.

ax replaces the loop with one command:

- **Fetch, never silent** — `{status, ok, ms, headers, body}` for every request. Empty bodies and error statuses still produce a full report. JSON bodies are parsed. Fetch mode never caches — every request is live. (`--body` gives you the classic pipe: body only on stdout.)
- **Discover, don't dump** — `--outline` shows a page's repeating structures; `--locate 'text'` answers "which selector holds this?" — no raw HTML ever hits the context. Parse-mode URLs are cached for ~2 minutes so probing is free (every hit announced on stderr; `--fresh` refetches, `--no-cache` never touches the disk).
- **Extract, structured** — `--row 'title=a, href=a@href'` pulls multi-field rows in one call; `--table` turns `<table>` into keyed rows; `--where` filters with a safe expression language.
- **Token-cheap by design** — results cap at 50 with a stderr note (never silent truncation), `--budget <tokens>` caps output by estimated tokens, rows default to header-once TSV (`--json` for JSON).

## Install

```sh
curl -fsSL https://ax.yusuke.run/install | sh
```

Teach your agent: `npx skills add yusukebe/ax` — or have it run `ax agent-context`.

## Nix

The project provides optional Nix flake outputs for users who already use Nix.
The flake wraps the prebuilt release binary.

```bash
# Run without installing
nix run github:yusukebe/ax

# Install into your profile
nix profile install github:yusukebe/ax
```

The flake tracks the default branch; `version` and the per-platform SRI hashes in
`flake.nix` are bumped at release time. (Release tags are cut before the bump lands,
so `github:yusukebe/ax/vX.Y.Z` is not a valid pin — use a specific commit SHA if
you need reproducibility.)

## Why not htmlq / curl / Firecrawl?

**htmlq is a selector; ax is the loop.** htmlq covers one step (CSS selector → text) and can't fetch, so every use marries it to curl. Multi-field extraction means running it N times and zipping by hand — exactly the moment agents give up and write python. ax does fetch + discovery + structured rows + tables + filtering in one binary, with agent-shaped output.

**curl is silent.** An empty 200 body prints nothing; agents re-run it with `-i`, `-w`, guessing. ax always reports.

**Firecrawl & friends return markdown blobs via metered cloud APIs.** ax is local, deterministic, zero-key, and returns _structure_ (rows, tables), not just prose. (For JavaScript-heavy SPAs you still want a browser tool — ax is the fast path for everything else.)

|                                                | throwaway python | curl + htmlq | ax  |
| ---------------------------------------------- | :--------------: | :----------: | :-: |
| fetch with a full report (status/headers/ms)   |   △ _write it_   |      ✗       |  ✓  |
| structure discovery (`--outline` / `--locate`) |        ✗         |      ✗       |  ✓  |
| CSS-selector extraction                        |  △ _needs bs4_   |      ✓       |  ✓  |
| multi-field rows in one call (`--row`)         |   △ _write it_   |      ✗       |  ✓  |
| `<table>` → keyed rows                         |   △ _write it_   |      ✗       |  ✓  |
| easier selector repair after markup drift      |   ✗ _(regex)_    |      ✓       |  ✓  |
| page → readable markdown (`--md`)              |        ✗         |      ✗       |  ✓  |
| token-shaped output (caps, `--budget`, notes)  |        ✗         |      ✗       |  ✓  |
| zero code authored per task                    |        ✗         |      ✓       |  ✓  |

(△ = possible, but the agent writes and debugs the code every time — that authoring cost is the whole point.)

## Measured

Real headless Claude Code sessions, same task, with and without ax — answers graded, both sides correct in every run:

| task (Opus 4.8, agent already knows ax)    | without ax   | with ax                 |
| ------------------------------------------ | ------------ | ----------------------- |
| two pages with markup drift (breaks regex) | $0.458       | **$0.150 (−67%)**       |
| clean extraction from a 60-item catalog    | $0.296 · 24s | **$0.104 · 14s (−65%)** |
| live website, decoy markup (median of 3)   | $0.248       | **$0.191 (−23%)**       |
| markup drift, agent's first-ever use of ax | $0.664       | **$0.282 (−58%)**       |

Full method — including the runs ax _lost_ — in [bench/RESULTS.md](bench/RESULTS.md).

## The full flag reference

Run `ax --help`, or `ax agent-context` for the agent-oriented playbook (also served at [ax.yusuke.run/llms.txt](https://ax.yusuke.run/llms.txt)).

## Built with

[Bun](https://bun.sh) (single-file binary via `bun build --compile`) and [linkedom](https://github.com/WebReflection/linkedom) for standard-DOM parsing — the only runtime dependency.
