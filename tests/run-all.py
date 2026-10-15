#!/usr/bin/env python3
"""Runs the static checks and every browser suite, prints one summary, exits 1 on any failure.
Usage: python3 tests/run-all.py   (needs Python, Playwright + Chromium, Pillow; see README.md)"""
import os, re, subprocess, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STEPS = [
    ("Static checks", "tools/check.py", None),
    ("Unit + integration (in-browser)", "tests/run-headless.py", r"Suite: (\d+)/(\d+) passed"),
    ("Screens end to end", "tests/run-ui.py", r"UI run: (\d+)/(\d+) steps passed"),
    ("Offline / install / update", "tests/run-pwa.py", r"PWA run: (\d+)/(\d+) steps passed"),
    ("Backup and restore end to end", "tests/run-backup.py", r"Backup e2e: (\d+)/(\d+) passed"),
]
rows, ok_all = [], True
for name, script, pat in STEPS:
    t0 = time.time()
    r = subprocess.run([sys.executable, os.path.join(ROOT, script)], capture_output=True, text=True, cwd=ROOT)
    out = r.stdout + r.stderr
    fails = [l for l in out.splitlines() if l.startswith("FAIL") or l.startswith("PAGE ERROR")]
    if pat:
        m = re.search(pat, out)
        result = f"{m.group(1)}/{m.group(2)}" if m else "no result line"
        good = bool(m) and m.group(1) == m.group(2) and r.returncode == 0 and not fails
    else:
        result = "clean" if r.returncode == 0 else "problems"
        good = r.returncode == 0
    ok_all &= good
    rows.append((name, result, "ok" if good else "FAILED", time.time() - t0))
    if not good: print(out[-3000:])
w = max(len(r[0]) for r in rows)
print()
for name, result, status, secs in rows: print(f"{name:<{w}}  {result:>14}  {status:<6} {secs:5.1f}s")
print("\nALL GREEN" if ok_all else "\nFAILURES ABOVE")
sys.exit(0 if ok_all else 1)
