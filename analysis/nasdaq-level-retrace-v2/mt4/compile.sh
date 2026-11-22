#!/bin/bash
# Compile an MQL4 source with a locally installed MetaEditor and print its log.
#
#   ./compile.sh [MetaEditor.exe] [path/to/File.mq4] [terminal data folder]
#
# With no arguments it builds LevelRetrace.mq4 into the LiteFinance MT4 data
# folder.  The source is copied to <data>\MQL4\Experts first, because
# MetaEditor writes the .ex4 next to whatever it compiles.
set -u
EDITOR="${1:-C:\\Program Files (x86)\\LiteFinance VC MT4 Terminal\\metaeditor.exe}"
SRC="${2:-$(dirname "$0")/LevelRetrace.mq4}"
DATA="${3:-C:/Users/TharHtwe/AppData/Roaming/MetaQuotes/Terminal/DBED2B1AA5190ECE30AE5FCFF29920C2}"

NAME=$(basename "$SRC")
DEST="$DATA/MQL4/Experts/$NAME"
LOG="$DATA/compile.log"
win() { printf '%s' "$1" | sed 's|/|\\|g'; }

cp "$SRC" "$DEST" || exit 1
powershell -NoProfile -Command \
  "Start-Process -FilePath '$EDITOR' -ArgumentList '/compile:\"$(win "$DEST")\"','/log:\"$(win "$LOG")\"' -Wait"
# the log is UTF-16LE; the raw bytes look like CJK garbage until it is converted
iconv -f UTF-16LE -t UTF-8 "$LOG" 2>/dev/null | tr -d '\000'
echo "artefact: $DEST"
