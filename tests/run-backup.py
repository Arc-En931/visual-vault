#!/usr/bin/env python3
"""End-to-end backup/restore test through the real UI (phone-sized headless Chromium, real IndexedDB, real downloads).
The downloaded ZIP is checked with Python's own zipfile/hashlib/PIL, i.e. NOT with the app's code.
Usage: python3 tests/run-backup.py      (CHROME_PATH overrides the browser)"""
import os, sys, subprocess, tempfile, time, io, json, hashlib, zipfile, random, traceback
from playwright.sync_api import sync_playwright
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8767
BASE = f"http://localhost:{PORT}/index.html"
CHROME = os.environ.get("CHROME_PATH", "/opt/pw-browsers/chromium-1194/chrome-linux/chrome")
tmp = tempfile.mkdtemp(prefix="vv-bk-")

results = []
def step(name):
    def deco(fn):
        try: fn(); results.append((True, name)); print("PASS  " + name)
        except Exception as e:
            msg = "".join(traceback.format_exception_only(type(e), e)).strip().splitlines()[0][:400]
            results.append((False, name)); print("FAIL  " + name + "\n        -> " + msg)
        return fn
    return deco
def check(c, m="check failed"):
    if not c: raise AssertionError(m)
def eq(a, e, w=""):
    if a != e: raise AssertionError(f"{w} expected {e!r} but got {a!r}".strip())

SEED = """async () => {
  const { openDatabase } = await import('./js/db.js'); const { Repository } = await import('./js/repository.js');
  const repo = new Repository(await openDatabase());
  const img = async (w, h, type, c) => { const cv = new OffscreenCanvas(w, h); const g = cv.getContext('2d'); g.fillStyle = c; g.fillRect(0, 0, w, h); g.fillStyle = '#fff'; g.fillRect(0, 0, w / 3, h / 3); return cv.convertToBlob({ type }); };
  const price = (await repo.listFieldDefinitions('image')).find((d) => d.name === 'Price');
  const weight = await repo.createFieldDefinition({ name: 'Weight', type: 'number', scope: 'product', unit: 'kg' });
  const kitchen = await repo.createCategory('Kitchen'); const metal = await repo.createTag('Metal');
  const mk = async (name, cat, specs, w) => {
    const p = await repo.saveProduct({ name, sku: name.slice(0, 2).toUpperCase() + '-1', description: 'About ' + name }, { categoryIds: cat ? [kitchen.id] : [], tagIds: cat ? [metal.id] : [], values: w ? [{ fieldId: weight.id, value: w }] : [] });
    for (const [type, caption, money, col] of specs) {
      const im = await repo.addImage({ productId: p.id, blob: await img(300, 200, type, col), thumb: await img(90, 60, 'image/jpeg', col), caption });
      await repo.saveImageDetails(im.id, { values: [{ fieldId: price.id, value: money }] });
    }
  };
  await mk('Steel cup', true, [['image/png', 'Small', '19.99', '#3c6eaa'], ['image/jpeg', 'Large', '24.50', '#aa6e3c']], '0.35');
  await mk('Café lamp 🙂', false, [['image/webp', 'On', '80', '#c8aa28']], null);
  repo.close();
}"""
SUMMARY = """async () => {
  const { openDatabase } = await import('./js/db.js'); const { Repository } = await import('./js/repository.js');
  const repo = new Repository(await openDatabase());
  const ps = await repo.listProducts(); const out = [];
  for (const p of ps) { const g = await repo.getProductGraph(p.id); out.push([p.name, g.images.map((i) => [i.caption, i.mime, i.size, !!i.thumb]), g.values.length, g.categoryIds.length, g.tagIds.length]); }
  const counts = { fields: (await repo.listFieldDefinitions()).length, cats: (await repo.listCategories()).length, tags: (await repo.listTags()).length };
  repo.close(); return { products: out, counts }; }"""

server = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1", "--directory", ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
errors = []
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=CHROME, args=["--no-sandbox"])
        def new_ctx():
            ctx = browser.new_context(viewport={"width": 393, "height": 851}, device_scale_factor=2, is_mobile=True, has_touch=True, accept_downloads=True)
            pg = ctx.new_page()
            pg.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
            pg.on("console", lambda m: errors.append("console.error: " + m.text) if m.type == "error" else None)
            return ctx, pg
        def go(pg, h):
            pg.goto("about:blank"); pg.goto(BASE + h); pg.wait_for_selector("main h1, main .empty, main .fatal")
        def no_overflow(pg): return pg.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")

        # ---------------- device A: has data, makes a backup ----------------
        ctxA, A = new_ctx()
        go(A, "#/"); A.evaluate(SEED)
        before = A.evaluate(SUMMARY)
        zpath = os.path.join(tmp, "backup.zip")

        @step("Backup tab: opens on a phone with no horizontal overflow; says no backup has been made yet")
        def _():
            go(A, "#/manage/backup")
            check("not downloaded a backup yet" in A.inner_text("main"), A.inner_text("main")[:300])
            check(no_overflow(A), "overflow")

        @step("Download backup: a real file is downloaded with a dated name; the page confirms and remembers the time")
        def _():
            with A.expect_download() as d: A.click("#backup-download")
            dl = d.value; dl.save_as(zpath)
            check(dl.suggested_filename.startswith("visualvault-backup-") and dl.suggested_filename.endswith(".zip"), dl.suggested_filename)
            A.wait_for_function("document.querySelector('#backup-status').textContent.includes('Backup created')")
            txt = A.inner_text("#backup-status")
            check("2 products" in txt and "3 photos" in txt, txt)
            check("Last backup downloaded:" in A.inner_text("main"))
            go(A, "#/manage/backup"); check("Last backup downloaded:" in A.inner_text("main"), "last-backup time not remembered")

        @step("INDEPENDENT CHECK (Python zipfile/hashlib/PIL): valid ZIP, stored not compressed, every checksum right, photos decode")
        def _():
            z = zipfile.ZipFile(zpath)
            eq(z.testzip(), None)
            check(all(i.compress_type == zipfile.ZIP_STORED for i in z.infolist()), "compressed entries")
            names = z.namelist(); eq(names[0], "manifest.json")
            m = json.loads(z.read("manifest.json")); eq(m["format"], "visualvault-backup"); eq(m["formatVersion"], 1)
            eq(sorted(m["files"]), sorted(n for n in names if n != "manifest.json"))
            for n, info in m["files"].items():
                data = z.read(n); eq(len(data), info["size"], n); eq(hashlib.sha256(data).hexdigest(), info["sha256"], n)
            d = json.loads(z.read("data.json"))
            eq([len(d["products"]), len(d["images"])], [2, 3])
            for im in d["images"]:
                Image.open(io.BytesIO(z.read(im["file"]))).verify(); Image.open(io.BytesIO(z.read(im["thumbFile"]))).verify()
            check("blob" not in d["images"][0] and "thumb" not in d["images"][0], "binary data leaked into data.json")
            eq(sorted(i["caption"] for i in d["images"]), ["Large", "On", "Small"])

        # ---------------- device B: brand-new browser profile ----------------
        ctxB, B = new_ctx()
        go(B, "#/manage/backup")
        def choose(path):
            B.set_input_files("#restore-file", path)
        def after_choose():
            B.wait_for_selector("#restore-ready, .problems", timeout=60000)

        @step("new phone: choosing the backup validates it and shows what it contains; nothing is imported yet")
        def _():
            choose(zpath); after_choose()
            txt = B.inner_text("#restore-ready")
            check("Backup is valid" in txt and "2 products" in txt and "3 photos" in txt and "Every file passed its checksum" in txt, txt)
            eq(len(B.evaluate(SUMMARY)["products"]), 0)
            check(no_overflow(B), "overflow on restore panel")

        @step("preview (default 'Skip existing') says exactly what will be added; Restore is enabled")
        def _():
            B.wait_for_function("document.querySelector('#restore-preview').textContent.startsWith('Will add')")
            txt = B.inner_text("#restore-preview")
            check("2 products" in txt and "3 photos" in txt and "Nothing here is deleted or overwritten" in txt, txt)
            check(B.is_enabled("#restore-go"))

        @step("Restore: completes, and the new profile now holds the same products, photos (with thumbnails), values, fields, categories and tags")
        def _():
            B.click("#restore-go"); B.wait_for_selector("#restore-done")
            check("Added 2 products and 3 photos" in B.inner_text("#restore-done"), B.inner_text("#restore-done"))
            now = B.evaluate(SUMMARY)
            ref = lambda s: sorted(s["products"], key=lambda x: x[0])
            eq(ref(now), ref(before))
            eq(now["counts"], before["counts"])

        @step("restored data is real in the UI: catalog lists both products and a restored photo thumbnail actually renders")
        def _():
            go(B, "#/"); B.wait_for_selector(".card")
            names = B.inner_text("main")
            check("Steel cup" in names and "Café lamp" in names, names[:300])
            B.wait_for_function("[...document.querySelectorAll('.card img')].some(i => i.complete && i.naturalWidth > 0)", timeout=8000)

        @step("restoring the same file again (Skip existing): preview says everything is already here, Restore is disabled, data unchanged")
        def _():
            go(B, "#/manage/backup"); choose(zpath); after_choose()
            B.wait_for_function("document.querySelector('#restore-preview').textContent.includes('already here')")
            check(B.is_disabled("#restore-go"), "Restore should be disabled")
            eq(len(B.evaluate(SUMMARY)["products"]), 2)

        @step("'Add as new': preview and result add a second copy of each product; the originals stay; fields/categories/tags are not duplicated")
        def _():
            B.get_by_label("Add as new").check()
            B.wait_for_function("document.querySelector('#restore-preview').textContent.startsWith('Will add 2 products')")
            B.click("#restore-go"); B.wait_for_selector("#restore-done")
            now = B.evaluate(SUMMARY)
            eq(len(now["products"]), 4); eq(now["counts"], before["counts"])
            eq(sorted(p[0] for p in now["products"]), ["Café lamp 🙂", "Café lamp 🙂", "Steel cup", "Steel cup"])
            check(all(len(p[1]) in (1, 2) for p in now["products"]), "photo counts")

        # ---------------- hostile / damaged files ----------------
        def rejected(path, needle):
            ctx, C = new_ctx(); go(C, "#/manage/backup")
            C.set_input_files("#restore-file", path); C.wait_for_selector("#restore-ready, .problems", timeout=60000)
            check(C.locator(".problems").count() == 1, "file was not rejected: " + C.inner_text("#restore-result")[:200])
            txt = C.inner_text(".problems")
            check(needle in txt, f"{needle!r} not in {txt!r}")
            check("Nothing was changed" in txt and C.locator("#restore-go").count() == 0, "must offer no Restore button")
            eq(len(C.evaluate(SUMMARY)["products"]), 0)
            check(no_overflow(C), "overflow on error panel"); ctx.close()
        zin = zipfile.ZipFile(zpath)
        def rezip(name, compress=zipfile.ZIP_STORED, mutate=None, extra=None):
            path = os.path.join(tmp, name)
            with zipfile.ZipFile(path, "w", compress) as zo:
                for i in zin.infolist():
                    data = zin.read(i.filename)
                    if mutate: data = mutate(i.filename, data)
                    zo.writestr(i.filename, data)
                for n, d in (extra or {}).items(): zo.writestr(n, d)
            return path

        @step("a ZIP re-saved by another tool WITH compression is refused with an explanation; nothing imported")
        def _(): rejected(rezip("deflated.zip", zipfile.ZIP_DEFLATED), "compressed")

        @step("a photo with one damaged byte is refused (checksum), naming the file")
        def _():
            def flip(n, d):
                if n.startswith("images/") and n.endswith(".png"): b = bytearray(d); b[len(b) // 2] ^= 0x01; return bytes(b)
                return d
            rejected(rezip("flipped.zip", mutate=flip), "does not match its checksum")

        @step("a ZIP with a path-traversal file name ('../evil.txt') is refused")
        def _(): rejected(rezip("traversal.zip", extra={"../evil.txt": b"x"}), "unsafe file name")

        @step("a truncated download (last 200 bytes missing) is refused")
        def _():
            raw = open(zpath, "rb").read(); path = os.path.join(tmp, "trunc.zip"); open(path, "wb").write(raw[:-200])
            rejected(path, "")

        @step("a random file renamed .zip, and an unrelated ZIP, are refused")
        def _():
            path = os.path.join(tmp, "junk.zip"); open(path, "wb").write(bytes(random.Random(1).randrange(256) for _ in range(5000)))
            rejected(path, "not a VisualVault backup")
            other = os.path.join(tmp, "other.zip")
            with zipfile.ZipFile(other, "w") as zo: zo.writestr("holiday.txt", "hi")
            rejected(other, "manifest.json is missing")

        @step("positive control: the same files re-zipped by another tool (STORED) ARE accepted and restore correctly")
        def _():
            ctx, C = new_ctx(); go(C, "#/manage/backup")
            C.set_input_files("#restore-file", rezip("restored-by-python.zip")); C.wait_for_selector("#restore-ready, .problems", timeout=60000)
            check(C.locator("#restore-ready").count() == 1, "valid re-zip rejected: " + C.inner_text("#restore-result")[:300])
            C.wait_for_function("document.querySelector('#restore-preview').textContent.startsWith('Will add')"); C.click("#restore-go"); C.wait_for_selector("#restore-done")
            eq(sorted(C.evaluate(SUMMARY)["products"], key=lambda x: x[0]), sorted(before["products"], key=lambda x: x[0])); ctx.close()

        @step("no JavaScript errors or failed console output during the whole run")
        def _(): eq(errors, [])
        browser.close()
finally:
    server.terminate()
bad = [n for ok, n in results if not ok]
print(f"\nBackup e2e: {len(results) - len(bad)}/{len(results)} passed")
sys.exit(1 if bad else 0)
