#!/usr/bin/env python3
"""Step D tests: manifest, installability, service worker, offline, update flow, sub-path hosting.
Drives real headless Chromium against a local server that mimics GitHub Pages (Cache-Control: max-age=600).
Usage: python3 tests/run-pwa.py      (CHROME_PATH overrides the browser binary)
"""
import functools, http.server, json, os, re, shutil, socket, subprocess, sys, tempfile, threading, traceback
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME = os.environ.get("CHROME_PATH", "/opt/pw-browsers/chromium-1194/chrome-linux/chrome")
ARGS = ["--no-sandbox"]
PHONE = dict(viewport={"width": 390, "height": 760}, has_touch=True, is_mobile=True, device_scale_factor=2)
tmp = tempfile.mkdtemp(prefix="vv-pwa-")


class Site:
    """Local test server. Default is no-store so Chrome's HTTP cache can never hide a service-worker bug during offline tests;
    the update scenario passes max-age=600 (what GitHub Pages sends) to prove installs bypass a stale HTTP cache. `down` makes it drop every connection
    (a real outage, which Playwright's set_offline does NOT impose on service-worker fetches); `hits` logs every request."""
    def __init__(self, directory, cache_control="no-store"):
        self.down, self.hits, site = False, [], self
        class H(http.server.SimpleHTTPRequestHandler):
            extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                              ".webmanifest": "application/manifest+json", ".js": "text/javascript"}
            def end_headers(self): self.send_header("Cache-Control", cache_control); super().end_headers()
            def log_message(self, *a): pass
            def do_GET(self):
                site.hits.append(self.path)
                if site.down: self.close_connection = True; self.connection.shutdown(socket.SHUT_RDWR); return
                super().do_GET()
        self.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(H, directory=directory))
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.base = f"http://localhost:{self.srv.server_address[1]}"
    def shutdown(self): self.srv.shutdown()
    def go_offline(self, ctx): self.down = True; ctx.set_offline(True); self.hits.clear()
    def go_online(self, ctx): self.down = False; ctx.set_offline(False)
    def assert_no_network_used(self):
        used = [h for h in self.hits if h.split("?")[0] != "/sw.js" and not h.endswith("/sw.js")]   # Chrome re-checks sw.js itself on navigation
        if used: raise AssertionError(f"requests reached the server while offline: {used[:5]}")


def copy_app(name):
    dst = os.path.join(tmp, name)
    shutil.copytree(ROOT, dst, ignore=shutil.ignore_patterns("tests", "__pycache__", ".git"))
    return dst


results, errors = [], []
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


def new_page(browser, watch=True, **kw):
    ctx = browser.new_context(**{**PHONE, **kw}); page = ctx.new_page()
    if watch:
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("response", lambda r: errors.append(f"HTTP {r.status} {r.url}") if r.status >= 400 else None)
    return ctx, page

def sw_active(page):
    page.wait_for_function("navigator.serviceWorker.ready.then(r => r.active && r.active.state === 'activated')", timeout=15000)
    page.wait_for_function("!!navigator.serviceWorker.controller", timeout=15000)

def cache_dump(page):
    return page.evaluate("""async () => { const o = {}; for (const k of await caches.keys()) {
        o[k] = (await (await caches.open(k)).keys()).map(r => new URL(r.url).pathname).sort(); } return o; }""")

def persistent(p, name):
    # Chrome only evaluates installability outside incognito; Playwright's plain contexts are incognito-like.
    return p.chromium.launch_persistent_context(os.path.join(tmp, name), executable_path=CHROME, args=ARGS, headless=True, **PHONE)

def sw_version(root):
    return re.search(r"const VERSION = '([^']*)'", open(os.path.join(root, "sw.js")).read()).group(1)

def precache_paths(root):
    src = open(os.path.join(root, "sw.js")).read()
    return re.findall(r"'([^']+)'", re.search(r"const PRECACHE = \[(.*?)\];", src, re.S).group(1))

def add_product(page, name):
    page.evaluate("location.hash = '#/product/new'"); page.wait_for_selector("#name")
    page.fill("#name", name); page.get_by_role("button", name="Save product").click()
    page.wait_for_selector(".toast:has-text('Saved')"); page.wait_for_selector("#photos-h")

def catalog_names(page):
    page.wait_for_selector(".sheet, .empty")
    return page.locator(".card strong").all_inner_texts()



def installability(ctx, page):
    cdp = ctx.new_cdp_session(page); cdp.send("Page.enable")
    man = cdp.send("Page.getAppManifest")
    return man, cdp.send("Page.getInstallabilityErrors")["installabilityErrors"]

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROME, args=ARGS)

    # ---------------------------------------------------------------- static files
    @step("sw.js: VERSION matches the files' contents; PRECACHE lists every app file and nothing missing")
    def _():
        r = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "stamp-sw.py"), "--check"], capture_output=True, text=True)
        check(r.returncode == 0, r.stdout + r.stderr)

    @step("manifest: required fields present; every icon exists with its declared size and type")
    def _():
        m = json.load(open(os.path.join(ROOT, "manifest.webmanifest")))
        for k in ("name", "short_name", "start_url", "scope", "display", "background_color", "theme_color", "icons", "id"): check(k in m, f"missing {k}")
        eq(m["display"], "standalone")
        check(not m["start_url"].startswith("/") and not m["scope"].startswith("/"), "start_url/scope must be relative so sub-path hosting works")
        from PIL import Image
        purposes = set()
        for ic in m["icons"]:
            im = Image.open(os.path.join(ROOT, ic["src"])); eq(f"{im.size[0]}x{im.size[1]}", ic["sizes"], ic["src"]); eq(im.format, "PNG"); purposes.add(ic["purpose"])
        check(purposes == {"any", "maskable"}, purposes)
        check(any(i["sizes"] == "192x192" for i in m["icons"]) and any(i["sizes"] == "512x512" for i in m["icons"]))

    site = Site(ROOT); base = site.base

    # ---------------------------------------------------------------- Chrome's own installability checks
    @step("Chromium's own manifest parser reports no errors and no installability blockers (non-incognito profile)")
    def _():
        ctx = persistent(p, "prof-install"); page = ctx.new_page(); page.goto(f"{base}/index.html"); sw_active(page)
        man, inst = installability(ctx, page)
        eq(man.get("errors"), [], "manifest errors"); eq(json.loads(man["data"])["display"], "standalone")
        eq(inst, [], "installability errors"); ctx.close()

    @step("negative control for that check: the same page in an incognito-like context IS reported as not installable")
    def _():
        ctx, page = new_page(browser, watch=False); page.goto(f"{base}/index.html"); sw_active(page)
        _, inst = installability(ctx, page); eq([e["errorId"] for e in inst], ["in-incognito"]); ctx.close()

    # ---------------------------------------------------------------- first install + offline
    ctx, page = new_page(browser)
    page.goto(f"{base}/index.html")

    @step("first visit: service worker installs, activates and takes control; user is told it works offline")
    def _():
        sw_active(page)
        page.wait_for_selector(".toast:has-text('Ready to work offline')")
        check(page.evaluate("navigator.serviceWorker.controller.scriptURL").endswith("/sw.js"))

    @step("cache holds exactly the PRECACHE files under the current VERSION - and nothing from /tests/ or elsewhere")
    def _():
        dump = cache_dump(page); eq(list(dump), [sw_version(ROOT)], "cache names")
        want = sorted({("/" + x) if x != "./" else "/" for x in precache_paths(ROOT)})
        eq(dump[sw_version(ROOT)], want, "cached URLs")

    @step("negative control: with the server down, a browser that never visited cannot load the page")
    def _():
        c2 = browser.new_context(); pg2 = c2.new_page(); site.go_offline(c2)
        try: pg2.goto(f"{base}/index.html"); raise AssertionError("page loaded with the server down and no cache")
        except Exception as e: check("net::" in str(e), str(e)[:200])
        c2.close(); site.go_online(ctx)

    @step("OFFLINE (server really down): reload shows the app and the seeded Price field; zero requests reach the server")
    def _():
        site.go_offline(ctx); page.reload(); page.wait_for_selector(".empty, .sheet")
        page.get_by_role("link", name="Manage").click(); page.wait_for_selector(".list li:has-text('Price')")
        eq(page.evaluate("fetch('/definitely-not-cached.txt').then(() => 'reached', () => 'failed')"), "failed", "network should be unreachable")
        site.hits[:] = [h for h in site.hits if "definitely-not-cached" not in h]
        errors[:] = [e for e in errors if e != "Failed to load resource: net::ERR_FAILED"]   # logged by the deliberate probe fetch above
        site.assert_no_network_used()

    @step("OFFLINE: add a product, close the tab, reopen the app offline - the product is still there (also bare URL, ?query, deep link)")
    def _():
        global page
        add_product(page, "Offline lamp")
        page.close(); page = ctx.new_page(); page.on("pageerror", lambda e: errors.append(str(e)))
        site.hits.clear()
        page.goto(f"{base}/index.html"); eq(catalog_names(page), ["Offline lamp"])
        page.goto(f"{base}/"); eq(catalog_names(page), ["Offline lamp"])
        page.goto(f"{base}/index.html?source=homescreen"); eq(catalog_names(page), ["Offline lamp"])
        page.evaluate("location.hash = '#/manage/tags'"); page.reload(); page.wait_for_selector(".tabs")
        eq(page.evaluate("[...document.querySelectorAll('.tabs a')].find(a => a.getAttribute('aria-current')).textContent.trim()"), "Tags")
        site.assert_no_network_used()

    @step("OFFLINE: every screen loads with no failed request and the stylesheet is applied")
    def _():
        failed = []; page.on("requestfailed", lambda r: failed.append(r.url)); site.hits.clear()
        page.goto(f"{base}/index.html"); page.wait_for_selector(".sheet")
        for h in ("#/", "#/product/new", "#/manage/fields", "#/manage/categories", "#/manage/tags", "#/manage/backup"):
            page.evaluate(f"location.hash = '{h}'"); page.wait_for_timeout(150)
        page.wait_for_selector("#backup-download")
        eq(failed, [], "failed requests")
        eq(page.evaluate("getComputedStyle(document.querySelector('.bar')).position"), "sticky", "css applied offline")
        site.assert_no_network_used()

    @step("OFFLINE: the Backup tab builds and downloads a valid ZIP containing the product added offline")
    def _():
        import zipfile, json as _json
        with page.expect_download() as d: page.click("#backup-download")
        path = os.path.join(tempfile.mkdtemp(), "offline.zip"); d.value.save_as(path)
        z = zipfile.ZipFile(path); eq(z.testzip(), None)
        names = [x["name"] for x in _json.loads(z.read("data.json"))["products"]]
        check(len(names) >= 1, "no products in the offline backup")
        site.assert_no_network_used()

    @step("ONLINE again: the app works and the offline-created data is intact")
    def _():
        site.go_online(ctx); page.goto(f"{base}/index.html"); eq(catalog_names(page), ["Offline lamp"])
    ctx.close()

    # ---------------------------------------------------------------- update flow
    app2 = copy_app("update-app"); site2 = Site(app2, cache_control="public, max-age=600"); base2 = site2.base; v1 = sw_version(app2)
    ctx, page = new_page(browser)
    page.goto(f"{base2}/index.html"); sw_active(page)        # NOTE: this page is never reloaded before the update arrives
    add_product(page, "Survivor")
    with open(os.path.join(app2, "css", "app.css"), "a") as f: f.write('\nbody { --vv-marker: "v2"; }\n')
    r = subprocess.run([sys.executable, os.path.join(app2, "tools", "stamp-sw.py")], capture_output=True, text=True)
    v2 = sw_version(app2)

    @step("update: a changed file gets a new VERSION; tools/stamp-sw.py flags a forgotten re-stamp")
    def _():
        global v2
        check(r.returncode == 0 and v2 != v1, f"{v1} -> {v2} {r.stdout}{r.stderr}")
        with open(os.path.join(app2, "css", "app.css"), "a") as f: f.write("/* edited */\n")
        bad = subprocess.run([sys.executable, os.path.join(app2, "tools", "stamp-sw.py"), "--check"], capture_output=True, text=True)
        check(bad.returncode == 1 and "stale" in bad.stdout, bad.stdout)
        subprocess.run([sys.executable, os.path.join(app2, "tools", "stamp-sw.py")], check=True, capture_output=True)
        v2 = sw_version(app2)

    @step("update: arrives while the FIRST session is still open (no reload); old version keeps running; 'Update now' offered")
    def _():
        page.evaluate("navigator.serviceWorker.getRegistration().then(r => r.update())")
        page.wait_for_function("navigator.serviceWorker.getRegistration().then(r => !!r.waiting)", timeout=15000)
        page.wait_for_selector(".toast:has-text('A new version') button:has-text('Update now')")
        eq(page.evaluate("getComputedStyle(document.body).getPropertyValue('--vv-marker').trim()"), "", "old css must still be active")
        d = cache_dump(page); check(v1 in d and v2 in d, list(d))

    @step("update: 'Later' dismisses the message and changes nothing; the next visit offers the update again")
    def _():
        page.get_by_role("button", name="Later").click(); check(page.locator(".toast:has-text('A new version')").count() == 0)
        page.reload(); page.wait_for_selector(".toast:has-text('A new version')")
        eq(page.evaluate("getComputedStyle(document.body).getPropertyValue('--vv-marker').trim()"), "", "still old")

    @step("update: 'Update now' switches to the new version (despite a 10-min HTTP cache), deletes the old cache, keeps all data")
    def _():
        page.get_by_role("button", name="Update now").click()
        page.wait_for_function("getComputedStyle(document.body).getPropertyValue('--vv-marker').includes('v2')", timeout=15000)
        page.evaluate("location.hash = '#/'"); eq(catalog_names(page), ["Survivor"])
        eq(list(cache_dump(page)), [v2], "only the new cache should remain")
        check(page.evaluate("navigator.serviceWorker.getRegistration().then(r => !r.waiting && !r.installing)"))
        page.reload(); page.wait_for_selector(".sheet")
        eq(page.evaluate("getComputedStyle(document.body).getPropertyValue('--vv-marker').includes('v2')"), True, "v2 css after reload despite max-age=600")
    ctx.close()

    # ---------------------------------------------------------------- failed update must not break the working version
    app3 = copy_app("broken-app"); site3 = Site(app3); base3 = site3.base; v1b = sw_version(app3)
    ctx, page = new_page(browser)
    page.goto(f"{base3}/index.html"); sw_active(page); add_product(page, "Keeper")

    @step("failed update (a listed file vanished from the server): old version stays in charge, no half-cache left, offline still works")
    def _():
        os.remove(os.path.join(app3, "icons", "favicon-32.png"))
        sw = open(os.path.join(app3, "sw.js")).read().replace(v1b, "vv-broken"); open(os.path.join(app3, "sw.js"), "w").write(sw)
        page.evaluate("navigator.serviceWorker.getRegistration().then(r => r.update())")
        page.wait_for_function("navigator.serviceWorker.getRegistration().then(r => !r.installing)", timeout=15000)
        page.wait_for_timeout(500)
        eq(page.evaluate("navigator.serviceWorker.getRegistration().then(r => [!!r.waiting, r.active.state])"), [False, "activated"])
        eq(list(cache_dump(page)), [v1b], "cache names")
        check(page.locator(".toast:has-text('A new version')").count() == 0, "must not offer a broken update")
        site3.go_offline(ctx); page.evaluate("location.hash = '#/'"); page.reload(); eq(catalog_names(page), ["Keeper"]); site3.assert_no_network_used()
    ctx.close()
    errors[:] = [e for e in errors if "favicon-32.png" not in e]      # that 404 is the deliberately broken file above

    # ---------------------------------------------------------------- hosting under a sub-path (GitHub Pages project sites)
    host = os.path.join(tmp, "host"); os.makedirs(os.path.join(host, "deep", "er")); os.symlink(ROOT, os.path.join(host, "deep", "er", "path"))
    site4 = Site(host); sub = f"{site4.base}/deep/er/path/"
    ctx, page = new_page(browser)
    page.goto(sub)

    @step("sub-path hosting (/deep/er/path/): worker scope, manifest and cached files all resolve under that path")
    def _():
        sw_active(page)
        eq(page.evaluate("navigator.serviceWorker.getRegistration().then(r => r.scope)"), sub)
        man, inst = installability(ctx, page)
        eq(man["errors"], [], "manifest errors"); eq(json.loads(man["data"])["display"], "standalone")
        d = cache_dump(page); only = list(d.values())[0]
        check(all(u.startswith("/deep/er/path/") for u in only) and len(only) == len(precache_paths(ROOT)), only[:3])

    @step("sub-path hosting: works offline (server down), including the bare folder URL and index.html")
    def _():
        add_product(page, "Subpath item"); site4.go_offline(ctx)
        page.goto(sub); eq(catalog_names(page), ["Subpath item"])
        page.goto(sub + "index.html"); eq(catalog_names(page), ["Subpath item"])
        site4.assert_no_network_used()
    ctx.close()

    @step("sub-path hosting in a non-incognito profile: Chromium reports no installability blockers")
    def _():
        site4.go_online(browser.new_context())
        c = persistent(p, "prof-sub"); pg = c.new_page(); pg.goto(sub); sw_active(pg)
        man, inst = installability(c, pg); eq(man["errors"], []); eq(inst, [], "installability errors")
        check(json.loads(man["data"])["scope"] is not None); c.close()

    # ---------------------------------------------------------------- robustness
    @step("a browser without service-worker support still runs the app normally (no errors)")
    def _():
        ctx, page = new_page(browser)
        page.add_init_script("Object.defineProperty(Navigator.prototype, 'serviceWorker', { get: () => undefined })")
        page.goto(f"{base}/index.html"); page.wait_for_selector(".empty, .sheet")
        eq(page.evaluate("typeof navigator.serviceWorker"), "undefined"); ctx.close()

    @step("if the worker script itself fails to register (server returns 404 for sw.js), the app still runs and only logs a warning")
    def _():
        app5 = copy_app("nosw-app"); os.remove(os.path.join(app5, "sw.js")); site5 = Site(app5)
        ctx, page = new_page(browser, watch=False); warnings = []
        page.on("console", lambda m: warnings.append(m.text) if m.type == "warning" else None)
        page.goto(f"{site5.base}/index.html"); page.wait_for_selector(".empty, .sheet"); page.wait_for_timeout(800)
        check(any("Offline support is unavailable" in w for w in warnings), warnings)
        add_product(page, "Still works"); eq(catalog_names(page.goto(f"{site5.base}/index.html") and page), ["Still works"])
        ctx.close(); site5.shutdown()

    @step("the tests pages are not intercepted by the worker (served from the network, never cached)")
    def _():
        ctx, page = new_page(browser, watch=False)
        page.goto(f"{base}/index.html"); sw_active(page)
        page.goto(f"{base}/tests/blank.html")
        body = page.evaluate("fetch('/tests/step-b.test.js').then(r => r.text())")
        check(body == open(os.path.join(ROOT, "tests", "step-b.test.js")).read(), "tests file should come straight from the server")
        check(not any("/tests/" in u for v in cache_dump(page).values() for u in v)); ctx.close()

    @step("no JavaScript errors, console errors or failed HTTP requests were logged during the whole run")
    def _():
        eq(errors, [], "errors")

    browser.close()

for st in (site, site2, site3, site4): st.shutdown()
shutil.rmtree(tmp, ignore_errors=True)
ok = sum(1 for r in results if r[0])
print(f"\nPWA run: {ok}/{len(results)} steps passed")
sys.exit(0 if ok == len(results) else 1)
