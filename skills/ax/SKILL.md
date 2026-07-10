---
name: ax
description: Use the ax CLI instead of curl + throwaway parsing scripts whenever you fetch a URL, explore an unknown web page, or extract structured data from HTML. Trigger whenever you are about to write an inline script (python3 heredoc, node -e, regex over HTML) or a bare curl for one-off web fetching, scraping, or page exploration.
---

# ax — the AI-era curl: fetch, discover, extract

One command: `ax <url|file|-> [selector] [flags]`. Never write regex over
HTML, and never use bare curl (it returns nothing on empty bodies).

## Cheatsheet

```sh
ax https://api.site.example/users                    # {status, ok, ms, headers, body} — never silent
ax https://api.site.example/users -H 'authorization: Bearer x' -X POST -d '{"a":1}'
# curl reflexes work: -u -I -o -k -m --data-raw (and -L/-i/-s/-f are no-ops)
ax https://site.example --outline                    # discover: repeating structures
ax https://site.example --locate 'some text'         # discover: which selector holds this
ax https://site.example '.card' --count              # confirm a hypothesis
ax https://site.example '.card' --row 'title=a, href=a@href, id=@data-id'
ax https://site.example 'table' --table --where 'Stars >= 30000'
ax https://site.example 'table' --table --where '`Col With Spaces` ~ /x/'
ax https://docs.site.example/guide --md --budget 800 # read docs as markdown
```

The workflow: fetch/--outline once → --locate/--count to confirm → ONE
--row/--table call. Repeat fetches of the same URL are cached ~2min, so
probing is free (--fresh to bypass).

## Speed discipline

Aim for ≤3 tool calls: one batched look (`ax URL --outline; ax URL '.guess' --count`),
one extraction call, then answer. Turns cost more than commands — semicolons
are free. Every --row/--table run prints `N rows extracted` + empty-field counts on stderr — that IS the verification; do not re-probe.
Answer with the data, concisely — no methodology narration.

## Output rules

- Default cap 50 results; stderr announces anything hidden. `--limit`,
  `--all`, `--budget <tokens>` control it. Rows default to token-cheap TSV; add `--json` if you need JSON.
- Errors are one stderr line with a hint — fix the flag, not the approach.
- If ax says "likely a JS-rendered SPA", stop probing selectors — switch to
  a browser tool; the content is not in the raw HTML.
- For plain text files and non-web work, use your usual tools — ax is for
  the web.
