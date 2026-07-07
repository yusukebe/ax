---
name: ax
description: Use the ax CLI instead of curl + throwaway parsing scripts whenever you fetch a URL, explore an unknown web page, or extract structured data from HTML. Trigger whenever you are about to write an inline script (python3 heredoc, node -e, regex over HTML) or a bare curl for one-off web fetching, scraping, or page exploration.
---

# ax — the AI-era curl: fetch, discover, extract

One command: `ax <url|file|-> [selector] [flags]`. Never write regex over
HTML, and never use bare curl (it returns nothing on empty bodies).

## Cheatsheet

```sh
ax https://api.site.com/users                    # {status, ok, ms, headers, body} — never silent
ax https://api.site.com/users -H 'authorization: Bearer x' -X POST -d '{"a":1}'
ax https://site.com --outline                    # discover: repeating structures
ax https://site.com --locate 'some text'         # discover: which selector holds this
ax https://site.com '.card' --count              # confirm a hypothesis
ax https://site.com '.card' --row 'title=a, href=a@href, id=@data-id'
ax https://site.com 'table' --table --where 'Stars >= 30000'
ax https://docs.site.com/guide --md --budget 800 # read docs as markdown
ax page.html '.review' --like 'battery complaints' --limit 10   # semantic rank
```

The workflow: fetch/--outline once → --locate/--count to confirm → ONE
--row/--table call. Repeat fetches of the same URL are cached ~2min, so
probing is free (--fresh to bypass).

## Speed discipline

Aim for ≤3 tool calls: one batched look (`ax URL --outline; ax URL '.guess' --count`),
one extraction call, then answer. Turns cost more than commands — semicolons
are free. ax is deterministic: don't re-verify consistent results.
Answer with the data, concisely — no methodology narration.

## Output rules

- Default cap 50 results; stderr announces anything hidden. `--limit`,
  `--all`, `--budget <tokens>` control it. `--tsv` for token-cheap rows.
- Errors are one stderr line with a hint — fix the flag, not the approach.
- --like is a high-recall funnel, not an oracle: for exhaustive tasks cast
  several differently-worded nets and union the results, then judge yourself.
- For plain text files and non-web work, use your usual tools — ax is for
  the web.
