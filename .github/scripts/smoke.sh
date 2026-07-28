#!/usr/bin/env bash
# The compiled binary must behave exactly like the same sources under bun.
#
# A --version check would exercise almost none of the compiled surface: the
# binary embeds a JavaScript engine for linkedom and fetch, and the port had to
# hand-roll argument parsing, DOM traversal, the TSV renderer and the --where
# evaluator. So every output mode is compared byte-for-byte against the bun
# entry point, which the test suite already covers.
set -uo pipefail

AX=${AX:-./ax}
pass=0
fail=0

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

cat >"$work/page.html" <<'HTML'
<html><body><article>
<h1>Title</h1><p>Hello <a href="/x">link</a> world.</p>
<ul><li class="item">one</li><li class="item">two</li></ul>
<table class="stats"><tr><th>Name</th><th>Stars</th></tr>
<tr><td>a</td><td>100</td></tr><tr><td>b</td><td>5</td></tr></table>
</article></body></html>
HTML

printf '<table><tr><th colspan=2>H</th></tr><tr><td>a</td><td>b</td></tr></table>' \
  >"$work/spans.html"

check() {
  local desc=$1
  shift
  local got want
  got=$("$AX" "$@" 2>&1)
  want=$(bun src/index.ts "$@" 2>&1)
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1))
    echo "ok    $desc"
  else
    fail=$((fail + 1))
    echo "FAIL  $desc"
    diff <(printf '%s\n' "$want") <(printf '%s\n' "$got") || true
  fi
}

page=$work/page.html

check version --version
check help --help
check agent-context agent-context
check text "$page" '.item' --text
check html "$page" '.item' --html
check attr "$page" a --attr href
check count "$page" '.item' --count
check markdown "$page" --md
check outline "$page" --outline
check locate "$page" --locate two
check table "$page" 'table.stats' --table
check table-json "$page" 'table.stats' --table --json
check colspan "$work/spans.html" --table
check where "$page" 'table.stats' --table --where 'Stars >= 50'
check where-regex "$page" 'table.stats' --table --where 'Name ~ /a/'
check where-and "$page" 'table.stats' --table --where 'Stars > 50 && Name == "a"'
check json "$page" '.item' --json
check envelope "$page" '.item' --json-envelope
check row "$page" '.item' --row 'v=, c=@class'
check paging "$page" '.item' --text --limit 1 --offset 1
check budget "$page" --md --budget 5
check bad-selector "$page" '>>>' --text
check no-such-file "$work/missing.html" --text
check no-selector "$page"
check unknown-flag "$page" '.item' --text --bogus

# stdin has no flag to compare through check()
got=$(printf '<p class=x>hi</p>' | "$AX" - '.x' --text 2>&1)
want=$(printf '<p class=x>hi</p>' | bun src/index.ts - '.x' --text 2>&1)
if [ "$got" = "$want" ]; then
  pass=$((pass + 1))
  echo "ok    stdin"
else
  fail=$((fail + 1))
  echo "FAIL  stdin"
  diff <(printf '%s\n' "$want") <(printf '%s\n' "$got") || true
fi

echo
echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
