"""Restore files that GitHub will not store as git blobs.

GitHub rejects a file over 100 MB. Those files are release assets on the
tag data-files. This writes each one back to the path in large-files.json.
A file that is already present at the recorded size is left alone.

    python tools/fetch_large_files.py

A private repository needs a token with repo scope in GH_TOKEN or GITHUB_TOKEN.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "large-files.json"
RELEASE = "https://github.com/TharHtwe/PropFirmKiller/releases/download/data-files/"


def main() -> int:
    rows = json.loads(MANIFEST.read_text(encoding="utf-8"))
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN") or ""
    missing = 0
    for row in rows:
        dest = ROOT / row["path"]
        size = int(row["bytes"])
        if dest.is_file() and dest.stat().st_size == size:
            print(f"keep {row['path']}")
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        url = RELEASE + row["asset"]
        print(f"get  {row['path']}")
        request = urllib.request.Request(url, headers={"User-Agent": "prop-firm-killer"})
        if token:
            request.add_header("Authorization", f"Bearer {token}")
        try:
            with urllib.request.urlopen(request) as response, dest.open("wb") as out:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    out.write(chunk)
        except Exception as exc:
            missing += 1
            print(f"fail {row['path']}: {exc}", file=sys.stderr)
            if dest.exists() and dest.stat().st_size != size:
                dest.unlink()
            continue
        got = dest.stat().st_size
        if got != size:
            missing += 1
            print(f"fail {row['path']}: size {got} != {size}", file=sys.stderr)
    return 1 if missing else 0


if __name__ == "__main__":
    raise SystemExit(main())
