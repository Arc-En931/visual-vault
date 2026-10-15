#!/usr/bin/env python3
"""Stamps sw.js with a version derived from the CONTENT of every file it precaches.
  python3 tools/stamp-sw.py           rewrite VERSION in sw.js (run before each deploy)
  python3 tools/stamp-sw.py --check   exit 1 if VERSION is stale, or PRECACHE and the real files disagree
"""
import hashlib, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SW = os.path.join(ROOT, "sw.js")
src = open(SW, encoding="utf-8").read()
m = re.search(r"const PRECACHE = \[(.*?)\];", src, re.S)
listed = re.findall(r"'([^']+)'", m.group(1))
files = [p for p in listed if p != "./"]

# Everything the app can load must be listed, and everything listed must exist (tests/, tools/, docs are not part of the app).
actual = set()
for top in ("css", "js", "icons"):
    for d, _, names in os.walk(os.path.join(ROOT, top)):
        for n in names: actual.add(os.path.relpath(os.path.join(d, n), ROOT).replace(os.sep, "/"))
actual |= {"index.html", "manifest.webmanifest"}
problems = []
for p in sorted(set(files) - actual): problems.append(f"listed in PRECACHE but missing on disk: {p}")
for p in sorted(actual - set(files)): problems.append(f"on disk but not in PRECACHE (will not work offline): {p}")
if len(files) != len(set(files)): problems.append("duplicate entries in PRECACHE")

h = hashlib.sha256()
for p in sorted(set(files) & actual):
    h.update(p.encode()); h.update(b"\0"); h.update(open(os.path.join(ROOT, p), "rb").read()); h.update(b"\0")
h.update(re.sub(r"const VERSION = '[^']*';", "", src).encode())     # the worker's own logic counts too
version = "vv-" + h.hexdigest()[:12]
cur = re.search(r"const VERSION = '([^']*)';", src).group(1)

if "--check" in sys.argv:
    if cur != version: problems.append(f"VERSION is stale ({cur}, files hash to {version}); run tools/stamp-sw.py")
    for p in problems: print("FAIL", p)
    if not problems: print(f"OK  {cur} matches {len(files)} files")
    sys.exit(1 if problems else 0)
if problems:
    for p in problems: print("FAIL", p)
    sys.exit(1)
if cur != version:
    open(SW, "w", encoding="utf-8").write(src.replace(f"const VERSION = '{cur}';", f"const VERSION = '{version}';"))
print(f"VERSION = {version} ({len(files)} files)")
