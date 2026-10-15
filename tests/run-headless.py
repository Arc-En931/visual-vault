#!/usr/bin/env python3
"""Runs the in-browser tests in headless Chromium against real IndexedDB, plus a close/reopen persistence check.
Usage: python3 tests/run-headless.py   (set CHROME_PATH to override the browser binary)"""
import os, sys, subprocess, tempfile, shutil, time, json
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8765
BASE = f"http://localhost:{PORT}"
CHROME = os.environ.get("CHROME_PATH", "/opt/pw-browsers/chromium-1194/chrome-linux/chrome")
ARGS = ["--no-sandbox"]

server = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1", "--directory", ROOT],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
failed = False
try:
    with sync_playwright() as p:
        # 1) full automated suite
        b = p.chromium.launch(executable_path=CHROME, args=ARGS)
        page = b.new_page()
        page.on("pageerror", lambda e: print("PAGE ERROR:", e))
        page.on("console", lambda m: print(m.text) if m.text.startswith("PERF") else None)
        page.goto(f"{BASE}/tests/index.html")
        page.wait_for_function("window.__vvResults && window.__vvResults.done", timeout=90000)
        res = page.evaluate("window.__vvResults")
        b.close()
        for r in res["results"]:
            print(("PASS  " if r["ok"] else "FAIL  ") + r["name"] + ("" if r["ok"] else "\n        -> " + r["error"]))
        print(f"\nSuite: {res['passed']}/{res['total']} passed")
        failed = res["passed"] != res["total"]

        # 2) close the browser completely, reopen with the same profile, read the data back
        prof = tempfile.mkdtemp(prefix="vv-profile-")
        write_js = """async () => {
          const { openDatabase } = await import('/js/db.js'); const { Repository } = await import('/js/repository.js');
          const repo = new Repository(await openDatabase('vv-persist'));
          const f = await repo.createFieldDefinition({ name: 'Price', type: 'money', scope: 'image' });
          const p = await repo.createProduct({ name: 'Steel cup' });
          const i = await repo.addImage({ productId: p.id, blob: new Blob(['pixels'], { type: 'image/png' }), caption: 'Medium cup' });
          await repo.setValue('image', i.id, f.id, 100);
          repo.close(); return p.id; }"""
        read_js = """async (pid) => {
          const { openDatabase } = await import('/js/db.js'); const { Repository } = await import('/js/repository.js');
          const repo = new Repository(await openDatabase('vv-persist'));
          const g = await repo.getProductGraph(pid);
          const img = g.images[0];
          const out = { name: g.product.name, caption: img.caption, blob: await img.blob.text(), price: g.imageValues[img.id][0].value };
          repo.close(); return out; }"""
        ctx = p.chromium.launch_persistent_context(prof, executable_path=CHROME, args=ARGS, headless=True)
        pg = ctx.new_page(); pg.goto(f"{BASE}/tests/blank.html")
        pid = pg.evaluate(write_js); ctx.close()
        ctx = p.chromium.launch_persistent_context(prof, executable_path=CHROME, args=ARGS, headless=True)
        pg = ctx.new_page(); pg.goto(f"{BASE}/tests/blank.html")
        got = pg.evaluate(read_js, pid); ctx.close()
        shutil.rmtree(prof, ignore_errors=True)
        ok = got == {"name": "Steel cup", "caption": "Medium cup", "blob": "pixels", "price": 10000}
        print(("PASS  " if ok else "FAIL  ") + "persistence: data survives full browser close + reopen (headless Chromium profile)", "" if ok else json.dumps(got))
        failed = failed or not ok
finally:
    server.terminate()
sys.exit(1 if failed else 0)
