#!/usr/bin/env python3
"""Static checks for VisualVault. Usage: python3 tools/check.py   (exit code 1 if anything fails)

1. JavaScript syntax (node --check) for every .js file.
2. Type/undefined-name/unused-variable check with `tsc` (checkJs, see tsconfig.check.json). Skipped with a
   notice if tsc is not installed (npm i -g typescript).
3. Python files compile and have no unused imports.
4. Whitespace hygiene: no CRLF, tabs (outside Markdown), trailing whitespace, missing final newline.
5. sw.js is stamped for the current files (same check tools/stamp-sw.py --check performs).
There is no auto-formatter here: this checks the rules, it does not rewrite code."""
import os, sys, ast, shutil, subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
problems = []

def walk(exts):
    for d, dirs, fs in os.walk("."):
        dirs[:] = [x for x in dirs if not x.startswith(".") and x != "node_modules" and x != "__pycache__"]
        for f in fs:
            if f.endswith(exts):
                yield os.path.join(d, f)

# 1. JS syntax
node = shutil.which("node")
if node:
    for f in sorted(walk((".js",))):
        r = subprocess.run([node, "--check", "--input-type=module"], stdin=open(f, "rb"), capture_output=True, text=True)
        if r.returncode: problems.append(f"syntax {f}: {r.stderr.strip().splitlines()[0] if r.stderr.strip() else 'error'}")
    print("1. JavaScript syntax: checked" if not any(p.startswith("syntax") for p in problems) else "1. JavaScript syntax: PROBLEMS")
else:
    print("1. JavaScript syntax: skipped (node not found)")

# 2. tsc
tsc = shutil.which("tsc") or "/home/claude/.npm-global/bin/tsc"
if os.path.exists(tsc) and os.path.exists("tsconfig.check.json"):
    r = subprocess.run([tsc, "-p", "tsconfig.check.json"], capture_output=True, text=True)
    if r.returncode: problems += ["tsc " + l for l in r.stdout.strip().splitlines() if l.strip()]
    print("2. Types / undefined names / unused variables (tsc): " + ("PROBLEMS" if r.returncode else "clean"))
else:
    print("2. tsc: skipped (not installed)")

# 3. Python
bad3 = 0
for f in sorted(walk((".py",))):
    src = open(f, encoding="utf-8").read()
    try: tree = ast.parse(src, f)
    except SyntaxError as e: problems.append(f"python {f}: {e}"); bad3 += 1; continue
    imported = {}
    for n in ast.walk(tree):
        if isinstance(n, ast.Import):
            for a in n.names: imported[(a.asname or a.name).split(".")[0]] = n.lineno
        elif isinstance(n, ast.ImportFrom):
            for a in n.names: imported[a.asname or a.name] = n.lineno
    used = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)}
    for k, ln in imported.items():
        if k not in used: problems.append(f"python {f}:{ln} unused import '{k}'"); bad3 += 1
print("3. Python compile + unused imports: " + ("PROBLEMS" if bad3 else "clean"))

# 4. Whitespace
bad4 = 0
for f in sorted(walk((".js", ".css", ".html", ".py", ".md", ".json", ".webmanifest"))):
    raw = open(f, "rb").read(); s = raw.decode("utf-8")
    if b"\r" in raw: problems.append(f"whitespace {f}: CRLF line endings"); bad4 += 1
    if s and not s.endswith("\n"): problems.append(f"whitespace {f}: no final newline"); bad4 += 1
    for i, line in enumerate(s.split("\n"), 1):
        if line != line.rstrip(): problems.append(f"whitespace {f}:{i} trailing whitespace"); bad4 += 1
        if "\t" in line and not f.endswith(".md"): problems.append(f"whitespace {f}:{i} tab character"); bad4 += 1
print("4. Whitespace hygiene: " + ("PROBLEMS" if bad4 else "clean"))

# 5. sw.js stamp
r = subprocess.run([sys.executable, "tools/stamp-sw.py", "--check"], capture_output=True, text=True)
if r.returncode: problems.append("stamp " + (r.stdout + r.stderr).strip().replace("\n", " "))
print("5. sw.js stamp: " + ("STALE" if r.returncode else "current"))

for p in problems: print("  -", p)
print(f"\n{len(problems)} problem(s)")
sys.exit(1 if problems else 0)
