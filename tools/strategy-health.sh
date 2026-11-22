#!/usr/bin/env bash
# Read-only health check for the strategy side of the TradingView2 analysis app.
#
#   bash tools/strategy-health.sh [project-root]
#
# It checks the toolchain, the datasets, the stored summaries, the running
# server and the MT4 install. It never starts a backtest and never writes a
# file. Exit code 0 = everything it can see is healthy.
set -u

ROOT="${1:-D:/TradingView2}"
PORT="${PORT:-8080}"
BASE="http://localhost:${PORT}"
FAILS=0

pass() { printf 'PASS  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; FAILS=$((FAILS + 1)); }
warn() { printf 'WARN  %s\n' "$*"; }
info() { printf 'INFO  %s\n' "$*"; }
head2() { printf '\n== %s ==\n' "$*"; }

head2 "Project"
[ -f "$ROOT/server.js" ] && pass "server.js present" || fail "server.js missing under $ROOT"
[ -d "$ROOT/analysis/nasdaq-level-retrace-v2" ] \
  && pass "strategy engine present" || fail "strategy engine folder missing"
[ -d "$ROOT/data" ] && pass "data/ present" || fail "data/ missing"
[ -d "$ROOT/public" ] && pass "public/ present" || fail "public/ missing"

head2 "Toolchain"
if command -v node >/dev/null 2>&1; then
  pass "node $(node -v)"
else
  fail "node not found on PATH"
fi

if command -v python >/dev/null 2>&1; then
  python - <<'PY'
import sys
try:
    import numpy, pandas, numba
except Exception as exc:
    print("FAIL  python deps: %s" % exc)
    sys.exit(1)
print("PASS  python %s (numpy %s, pandas %s, numba %s)"
      % (sys.version.split()[0], numpy.__version__, pandas.__version__, numba.__version__))
PY
  [ $? -eq 0 ] || FAILS=$((FAILS + 1))
else
  fail "python not found on PATH (set STRATEGY_PYTHON when starting the server)"
fi

head2 "Datasets (data/)"
for f in "$ROOT"/data/*.csv; do
  [ -e "$f" ] || continue
  # Only MT5 exports are usable by the strategy engine.
  if head -c 512 "$f" | grep -q '<DATE>'; then
    info "MT5  $(basename "$f")  $(du -h "$f" | cut -f1)"
  else
    info "other $(basename "$f")  $(du -h "$f" | cut -f1)  (not an MT5 export)"
  fi
done

head2 "Stored results"
python - "$ROOT" <<'PY'
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
base = root / "analysis" / "nasdaq-level-retrace-v2" / "results"
if not base.is_dir():
    print("FAIL  results/ missing")
    sys.exit(1)

found = 0
bad = 0
for path in sorted(base.glob("*/summary.json")):
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        print("FAIL  %s: unreadable summary (%s)" % (path.parent.name, exc))
        bad += 1
        continue
    meta = data.get("meta") or {}
    runs = len(data.get("runs") or [])
    configs = meta.get("configs")
    expected = configs or 6144
    if runs == expected:
        print("PASS  %-42s %d/%d runs, audit_day %s"
              % (path.parent.name, runs, expected, meta.get("audit_day")))
    elif runs:
        print("WARN  %-42s %d/%d runs (partly computed), audit_day %s"
              % (path.parent.name, runs, expected, meta.get("audit_day")))
    else:
        print("WARN  %-42s no runs yet" % path.parent.name)
    found += 1

if not found:
    print("WARN  no summary.json yet: open /strategy/ and press Run missing")
    sys.exit(0)
sys.exit(1 if bad else 0)
PY
[ $? -eq 0 ] || FAILS=$((FAILS + 1))

head2 "Event cache"
CACHE="$ROOT/analysis/nasdaq-level-retrace-v2/results/cache"
if [ -d "$CACHE" ]; then
  events=$(find "$CACHE" -maxdepth 1 -name 'events_*.npz' 2>/dev/null | wc -l | tr -d ' ')
  bars=$(find "$CACHE" -maxdepth 1 -name 'bars_*.npz' 2>/dev/null | wc -l | tr -d ' ')
  info "$bars bar cache(s), $events event cache(s)"
  [ "$events" -gt 0 ] && pass "event caches are warm" \
    || warn "no event caches: the first run of each level session will be slow"
else
  warn "results/cache/ missing: the first run will build every cache"
fi

head2 "Server on $BASE"
if curl -s --max-time 5 -o /dev/null "$BASE/"; then
  pass "GET /"
  for path in /strategy/ /api/strategy/files /api/strategy/status; do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE$path")
    if [ "$code" = "200" ]; then pass "GET $path ($code)"; else fail "GET $path ($code)"; fi
  done

  files=$(curl -s --max-time 10 "$BASE/api/strategy/files" \
    | python -c "import json,sys; print(len(json.load(sys.stdin).get('files',[])))" 2>/dev/null)
  if [ -n "${files:-}" ]; then
    pass "$files MT5 dataset(s) listed"
  else
    fail "could not parse /api/strategy/files"
  fi

  running=$(curl -s --max-time 10 "$BASE/api/strategy/status" \
    | python -c "import json,sys; d=json.load(sys.stdin); print('running' if d.get('running') else 'idle')" 2>/dev/null)
  info "strategy status: ${running:-unknown}"
else
  warn "server not reachable (start it with: cd $ROOT && npm start)"
fi

head2 "MetaTrader 4 (optional)"
SRC="$ROOT/analysis/nasdaq-level-retrace-v2/mt4/LevelRetrace.mq4"
[ -f "$SRC" ] && pass "EA source present" || fail "EA source missing"

MT4_DATA="${MT4_DATA:-${APPDATA:-$HOME/AppData/Roaming}/MetaQuotes/Terminal/DBED2B1AA5190ECE30AE5FCFF29920C2}"
command -v cygpath >/dev/null 2>&1 && MT4_DATA=$(cygpath -u "$MT4_DATA" 2>/dev/null || printf '%s' "$MT4_DATA")
if [ -d "$MT4_DATA/MQL4/Experts" ]; then
  pass "MT4 data folder found"
  [ -f "$MT4_DATA/MQL4/Experts/LevelRetrace.mq4" ] \
    && pass "EA installed (source)" || warn "EA source not copied to MQL4/Experts"
  if [ -f "$MT4_DATA/MQL4/Experts/LevelRetrace.ex4" ]; then
    pass "EA compiled (.ex4)"
    if [ -f "$MT4_DATA/MQL4/Experts/LevelRetrace.mq4" ] \
       && [ "$MT4_DATA/MQL4/Experts/LevelRetrace.mq4" -nt "$MT4_DATA/MQL4/Experts/LevelRetrace.ex4" ]; then
      warn ".mq4 is newer than .ex4: recompile with bash mt4/compile.sh"
    fi
  else
    warn "LevelRetrace.ex4 missing: compile before attaching"
  fi
else
  warn "MT4 data folder not found; skipping EA install checks"
fi

printf '\n'
if [ "$FAILS" -eq 0 ]; then
  printf 'RESULT: healthy (no failures)\n'
  exit 0
fi
printf 'RESULT: %d failure(s)\n' "$FAILS"
exit 1
