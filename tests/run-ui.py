#!/usr/bin/env python3
"""End-to-end UI test: drives the real app in headless Chromium (phone-sized touch viewport, real IndexedDB).
Usage: python3 tests/run-ui.py      (CHROME_PATH overrides the browser; SHOTS=dir keeps screenshots)
"""
import os, sys, subprocess, tempfile, time, traceback
from playwright.sync_api import sync_playwright
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8766
BASE = f"http://localhost:{PORT}/index.html"
CHROME = os.environ.get("CHROME_PATH", "/opt/pw-browsers/chromium-1194/chrome-linux/chrome")
SHOTS = os.environ.get("SHOTS")
if SHOTS: os.makedirs(SHOTS, exist_ok=True)

tmp = tempfile.mkdtemp(prefix="vv-ui-")
def make_png(name, size, color):
    path = os.path.join(tmp, name)
    img = Image.new("RGB", size, color)
    for x in range(size[0] // 3):               # a lighter block so thumbnails are not flat colour
        for y in range(size[1] // 3):
            img.putpixel((x, y), (255, 255, 255))
    img.save(path, "PNG")
    return path
F = {
    "small": make_png("small.png", (400, 300), (60, 110, 170)),
    "medium": make_png("medium.png", (400, 300), (170, 110, 60)),
    "large": make_png("large.png", (400, 300), (60, 150, 90)),
    "replacement": make_png("replacement.png", (120, 90), (150, 60, 150)),
    "mug": make_png("mug.png", (300, 300), (40, 90, 140)),
    "lamp": make_png("lamp.png", (300, 400), (200, 170, 40)),
}

results = []
def step(name):
    def deco(fn):
        try:
            fn(); results.append((True, name, ""))
            print("PASS  " + name)
        except Exception as e:
            msg = "".join(traceback.format_exception_only(type(e), e)).strip().splitlines()[0][:300]
            results.append((False, name, msg)); print("FAIL  " + name + "\n        -> " + msg)
        return fn
    return deco

def check(cond, msg="check failed"):
    if not cond: raise AssertionError(msg)
def eq(actual, expected, what=""):
    if actual != expected: raise AssertionError(f"{what} expected {expected!r} but got {actual!r}".strip())

server = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1", "--directory", ROOT],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
errors = []
dialogs = []
dialog_accept = [True]
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=CHROME, args=["--no-sandbox"])
        ctx = browser.new_context(viewport={"width": 393, "height": 851}, device_scale_factor=2, is_mobile=True, has_touch=True)
        ctx.add_init_script("""window.__urls={created:0,revoked:0};
          const c=URL.createObjectURL.bind(URL), r=URL.revokeObjectURL.bind(URL);
          URL.createObjectURL=(b)=>{window.__urls.created++;return c(b)}; URL.revokeObjectURL=(u)=>{window.__urls.revoked++;return r(u)};""")
        # A toast seen after a click must come from THAT click, never a leftover from an earlier action.
        from playwright.sync_api import Locator
        _orig_click, _orig_dbl = Locator.click, Locator.dblclick
        def _clear(loc):
            try: loc.page.evaluate("document.querySelectorAll('#toasts .toast').forEach(e=>e.remove())")
            except Exception: pass
        Locator.click = lambda self, *a, **k: (_clear(self), _orig_click(self, *a, **k))[1]
        Locator.dblclick = lambda self, *a, **k: (_clear(self), _orig_dbl(self, *a, **k))[1]
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
        page.on("console", lambda m: errors.append("console.error: " + m.text) if m.type == "error" else None)
        def on_dialog(d):
            dialogs.append(d.message)
            d.accept() if dialog_accept[0] else d.dismiss()
        page.on("dialog", on_dialog)

        def shot(name):
            if SHOTS: page.screenshot(path=os.path.join(SHOTS, name + ".png"))
        def toast_has(text, timeout=6000):
            page.locator("#toasts .toast").filter(has_text=text).first.wait_for(timeout=timeout)
        def go(hash_):
            page.goto("about:blank"); page.goto(BASE + hash_)      # fresh load: no leftover in-memory search state
            page.wait_for_selector("main h1, main .empty, main .fatal")
        def no_overflow():
            return page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")
        def add_photos(paths):
            with page.expect_file_chooser() as fc:
                page.get_by_role("button", name="Add photos").click()
            fc.value.set_files(paths)
        def open_photo(n):
            page.locator(".photos li").nth(n).locator("a").click()
            page.wait_for_selector("#caption")
        def set_photo(caption, price):
            page.fill("#caption", caption)
            page.get_by_label("Price", exact=True).fill(price)
            page.get_by_role("button", name="Save photo details").click()
            toast_has("Saved")
        def new_product(name, sku="", category=None, tag=None):
            go("#/product/new")
            page.fill("#name", name)
            if sku: page.fill("#sku", sku)
            if category:
                page.get_by_label("New category name").fill(category)
                page.locator("fieldset", has_text="Categories").get_by_role("button", name="Add", exact=True).click()
                page.wait_for_selector(f'.chip[aria-pressed="true"]:has-text("{category}")')
            if tag:
                page.get_by_label("New tag name").fill(tag)
                page.locator("fieldset", has_text="Tags").get_by_role("button", name="Add", exact=True).click()
                page.wait_for_selector(f'.chip[aria-pressed="true"]:has-text("{tag}")')
            page.get_by_role("button", name="Save product").click()
            toast_has("Saved")
            page.wait_for_selector("#photos-h")

        # ------------------------------------------------------------------
        @step("first run: empty catalog invites the first product; default Price field exists")
        def _():
            page.goto(BASE); page.wait_for_selector("text=Your catalog is empty")
            shot("01-empty")
            check(no_overflow(), "horizontal overflow on phone width")
            page.get_by_role("link", name="Manage").click(); page.wait_for_selector("h1:has-text('Manage')")
            li = page.locator(".list li", has_text="Price")
            check(li.count() == 1, "default Price field missing")
            check("Money" in li.inner_text() and "Each photo" in li.inner_text(), li.inner_text())
            page.get_by_role("link", name="Catalog").click(); page.wait_for_selector("text=Your catalog is empty")

        @step("create Steel cup with a new category and tag; saved product opens its page")
        def _():
            page.get_by_role("link", name="Add your first product").click()
            page.wait_for_selector("#name")
            page.fill("#name", "Steel cup"); page.fill("#sku", "SC-1")
            page.fill("#description", "Insulated travel mug"); page.fill("#notes", "dishwasher safe")
            page.get_by_label("New category name").fill("Kitchen")
            page.locator("fieldset", has_text="Categories").get_by_role("button", name="Add", exact=True).click()
            page.get_by_label("New tag name").fill("Metal")
            page.locator("fieldset", has_text="Tags").get_by_role("button", name="Add", exact=True).click()
            page.wait_for_selector('.chip[aria-pressed="true"]:has-text("Metal")')
            page.get_by_role("button", name="Save product").click()
            toast_has("Saved"); page.wait_for_selector("#photos-h")
            check("/product/" in page.url and not page.url.endswith("/new"), page.url)
            eq(page.locator("h1").inner_text(), "Steel cup")

        @step("save with an empty name is refused with a clear message and nothing is created")
        def _():
            go("#/product/new")
            page.get_by_role("button", name="Save product").click()
            toast_has("Product name is required")
            check("#/product/new" in page.url)

        @step("add three photos at once; thumbnails appear in the order picked")
        def _():
            go("#/")
            page.locator(".cardlink", has_text="Steel cup").click(); page.wait_for_selector("#photos-h")
            add_photos([F["small"], F["medium"], F["large"]])
            toast_has("3 photos added")
            page.wait_for_function("document.querySelectorAll('.photos li img').length===3")
            page.wait_for_function("[...document.querySelectorAll('.photos li img')].every(i=>i.complete&&i.naturalWidth>0)")
            shot("02-product-with-photos")

        @step("Steel cup scenario: captions and prices small 20 / medium 100 / large 500 saved per photo")
        def _():
            for i, (cap, price) in enumerate([("Small cup", "20"), ("Medium cup", "100"), ("Large cup", "500")]):
                open_photo(i); set_photo(cap, price)
                page.get_by_role("link", name="Back to product").click(); page.wait_for_selector("#photos-h")
            open_photo(1)
            eq(page.locator("#caption").input_value(), "Medium cup")
            eq(page.get_by_label("Price", exact=True).input_value(), "100.00", "price shows 2 decimals")
            shot("03-image-editor")
            check(no_overflow(), "overflow on image editor")

        @step("catalog card shows the price range across photos; thumbnails really load")
        def _():
            go("#/")
            page.wait_for_selector(".card")
            check("Price 20.00–500.00" in page.locator(".card").first.inner_text(), page.locator(".card").first.inner_text())
            page.wait_for_function("[...document.querySelectorAll('.card img')].every(i=>i.complete&&i.naturalWidth>0)")

        @step("search 'medium' finds the product and its hit link opens that exact photo")
        def _():
            page.wait_for_selector(".card")
            page.fill("#q", "medium")
            page.wait_for_selector(".hit")
            eq(page.locator(".card").count(), 1)
            eq(page.locator(".hit").count(), 1)
            eq(page.locator(".hit").inner_text(), "Medium cup")
            shot("04-search-hit")
            page.locator(".hit").click(); page.wait_for_selector("#caption")
            eq(page.locator("#caption").input_value(), "Medium cup")
            eq(page.get_by_label("Price", exact=True).input_value(), "100.00")

        @step("price filter 100–500 lists the medium and large photos; bad input shows an error, not a crash")
        def _():
            go("#/")
            page.wait_for_selector(".card")
            page.get_by_text("Filters and sort").click()
            page.get_by_role("button", name="Add a field filter").click()
            page.get_by_label("Price Min").fill("100"); page.get_by_label("Price Max").fill("500")
            page.wait_for_function("document.querySelectorAll('.hit').length===2")
            eq([t for t in page.locator(".hit").all_inner_texts()], ["Medium cup", "Large cup"])
            page.get_by_label("Price Min").fill("abc")
            page.wait_for_selector(".status.error:has-text('Price minimum')")
            page.get_by_label("Price Min").fill("101"); page.get_by_label("Price Max").fill("499")
            page.wait_for_selector("text=No products match")
            shot("05-filter-none")
            page.get_by_role("button", name="Clear search and filters").first.click()
            page.wait_for_selector(".card")

        @step("editing only the medium price (to 150) leaves small and large untouched")
        def _():
            go("#/"); page.locator(".cardlink", has_text="Steel cup").click(); page.wait_for_selector("#photos-h")
            open_photo(1); set_photo("Medium cup", "150")
            for i, (cap, price) in enumerate([("Small cup", "20.00"), ("Medium cup", "150.00"), ("Large cup", "500.00")]):
                go("#/"); page.locator(".cardlink", has_text="Steel cup").click(); page.wait_for_selector("#photos-h")
                open_photo(i)
                eq(page.locator("#caption").input_value(), cap); eq(page.get_by_label("Price", exact=True).input_value(), price, cap)

        @step("invalid price is rejected with the field name; the old price stays")
        def _():
            go("#/"); page.locator(".cardlink", has_text="Steel cup").click(); page.wait_for_selector("#photos-h")
            open_photo(0)
            page.get_by_label("Price", exact=True).fill("1.999")
            page.get_by_role("button", name="Save photo details").click()
            toast_has("Price: Enter an amount like 20 or 19.99")
            page.get_by_label("Price", exact=True).fill("20.00")   # back to the saved value: no longer 'unsaved'

        @step("reorder: 'Move earlier' puts Medium first and the order survives a full page reload")
        def _():
            go("#/"); page.locator(".cardlink", has_text="Steel cup").click(); page.wait_for_selector("#photos-h")
            open_photo(1)
            page.get_by_role("button", name="Move earlier").click(); toast_has("Moved to position 1")
            check("Photo 1 of 3" in page.locator(".pager").inner_text())
            page.reload(); page.wait_for_selector("#caption")
            page.get_by_role("link", name="← Steel cup").click(); page.wait_for_selector(".photos li")
            caps = [t.strip() for t in page.locator(".photos .cap").all_inner_texts()]
            eq(caps, ["Medium cup", "Small cup", "Large cup"])
            open_photo(0); eq(page.get_by_label("Price", exact=True).input_value(), "150.00", "price followed its photo")

        @step("moving a photo and then saving WITHOUT reloading does not raise a false 'changed elsewhere' conflict")
        def _():
            page.get_by_role("link", name="← Steel cup").click(); page.wait_for_selector(".photos li")
            open_photo(0)                                   # Medium cup, no reload from here on
            eq(page.locator("#caption").input_value(), "Medium cup")
            page.get_by_role("button", name="Move later").click(); toast_has("Moved to position 2")
            page.get_by_role("button", name="Move earlier").click(); toast_has("Moved to position 1")
            page.fill("#caption", "Medium cup (steel)")
            page.get_by_role("button", name="Save photo details").click(); toast_has("Saved")
            eq(page.locator("#toasts .toast.error").count(), 0, "error toasts")
            page.fill("#caption", "Medium cup")
            page.get_by_role("button", name="Save photo details").click(); toast_has("Saved")
            eq(page.locator("#toasts .toast.error").count(), 0, "error toasts")

        @step("replace a photo: new image shows, caption/price/position are kept")
        def _():
            page.get_by_role("link", name="← Steel cup").click(); page.wait_for_selector(".photos li")
            open_photo(2)
            eq(page.locator(".photo-view img").evaluate("i=>i.naturalWidth"), 400)
            with page.expect_file_chooser() as fc:
                page.get_by_role("button", name="Replace photo").click()
            fc.value.set_files(F["replacement"])
            toast_has("Photo replaced")
            page.wait_for_function("document.querySelector('.photo-view img').naturalWidth===120")
            eq(page.locator("#caption").input_value(), "Large cup")
            eq(page.get_by_label("Price", exact=True).input_value(), "500.00")
            check("Photo 3 of 3" in page.locator(".pager").inner_text())

        @step("a text file renamed .png is rejected by name; no photo is added")
        def _():
            page.get_by_role("link", name="← Steel cup").click(); page.wait_for_selector(".photos li")
            n = page.locator(".photos li").count()
            with page.expect_file_chooser() as fc:
                page.get_by_role("button", name="Add photos").click()
            fc.value.set_files([{"name": "bad.png", "mimeType": "image/png", "buffer": b"this is not an image"}])
            toast_has('"bad.png" is not a supported image')
            eq(page.locator(".photos li").count(), n)

        @step("a mixed batch (good + bad) adds the good photo and reports the bad one")
        def _():
            n = page.locator(".photos li").count()
            with page.expect_file_chooser() as fc:
                page.get_by_role("button", name="Add photos").click()
            fc.value.set_files([{"name": "mug.png", "mimeType": "image/png", "buffer": open(F["mug"], "rb").read()},
                                {"name": "oops.jpg", "mimeType": "image/jpeg", "buffer": b"\xff\xd8\xff garbage"}])
            toast_has("1 photo added"); toast_has('"oops.jpg"')
            page.wait_for_function(f"document.querySelectorAll('.photos li').length=={n + 1}")

        @step("delete one photo (with confirmation): the others and the product stay")
        def _():
            open_photo(1)       # Small cup
            eq(page.locator("#caption").input_value(), "Small cup")
            dialogs.clear()
            page.get_by_role("button", name="Delete photo").click()
            toast_has("Photo deleted"); page.wait_for_selector("#photos-h")
            check(any("Delete this photo" in d for d in dialogs), dialogs)
            caps = [t.strip() for t in page.locator(".photos .cap").all_inner_texts()]
            eq(caps, ["Medium cup", "Large cup", "No caption"])
            open_photo(1); eq(page.get_by_label("Price", exact=True).input_value(), "500.00")

        @step("unsaved changes: leaving asks first; Cancel keeps you here, OK leaves")
        def _():
            page.fill("#caption", "Large cup EDITED")
            dialogs.clear(); dialog_accept[0] = False
            page.get_by_role("link", name="Catalog").click()
            page.wait_for_timeout(300)
            check(any("unsaved" in d.lower() for d in dialogs), dialogs)
            check("/image/" in page.url, "should still be on the photo page: " + page.url)
            eq(page.locator("#caption").input_value(), "Large cup EDITED", "typed text must survive")
            dialog_accept[0] = True
            page.get_by_role("link", name="Catalog").click(); page.wait_for_selector(".card, .empty")
            check("/image/" not in page.url)

        @step("double-tapping Save on a new product creates exactly one product")
        def _():
            go("#/product/new"); page.fill("#name", "Double tap test")
            page.get_by_role("button", name="Save product").dblclick()
            page.wait_for_selector("#photos-h")
            page.wait_for_timeout(300)
            go("#/"); page.fill("#q", "double tap")
            page.wait_for_timeout(400)
            eq(page.locator(".card").count(), 1)

        @step("categories/tags: filter the catalog; 'all' vs 'any' matching")
        def _():
            new_product("Ceramic mug", "CM-2", category="Kitchen", tag="Ceramic")
            add_photos([F["mug"]]); toast_has("1 photo added")
            open_photo(0); set_photo("Blue glaze", "15.5")
            new_product("Desk lamp", "DL-3", category="Office")
            add_photos([F["lamp"]]); toast_has("1 photo added")
            open_photo(0); set_photo("Brass lamp", "49")
            go("#/"); page.wait_for_function("document.querySelectorAll('.card').length>=3")
            page.get_by_text("Filters and sort").click()
            page.locator(".chips .chip", has_text="Kitchen").click()
            page.wait_for_function("document.querySelectorAll('.card').length===2")
            page.locator(".chips .chip", has_text="Ceramic").click()
            page.locator(".chips .chip", has_text="Metal").click()
            page.select_option("#match", "all")
            page.wait_for_selector("text=No products match")
            page.select_option("#match", "any")
            page.wait_for_function("document.querySelectorAll('.card').length===2")
            page.get_by_role("button", name="Clear search and filters").click()
            page.wait_for_function("document.querySelectorAll('.card').length>=3")

        @step("sort by Price high to low puts Steel cup (500) first, Desk lamp (49) next")
        def _():
            page.get_by_text("Filters and sort").click() if not page.locator("details.filters[open]").count() else None
            page.select_option("#sort", label="Price: high to low")
            page.wait_for_timeout(300)
            names = [t.split("\n")[0] for t in page.locator(".card .meta strong").all_inner_texts()]
            check(names[:3] == ["Steel cup", "Desk lamp", "Ceramic mug"], str(names))
            shot("06-catalog-sorted")
            page.select_option("#sort", label="Price: low to high"); page.wait_for_timeout(300)
            names = page.locator(".card .meta strong").all_inner_texts()
            check(names[0] == "Ceramic mug", str(names))

        @step("search finds text in captions, SKU and tags, accent/case-insensitive")
        def _():
            for q, expect in [("GLAZE", "Ceramic mug"), ("dl-3", "Desk lamp"), ("metal", "Steel cup"), ("brass", "Desk lamp")]:
                go("#/"); page.wait_for_selector(".card")
                page.get_by_role("button", name="Clear search and filters").click() if page.locator("details.filters[open]").count() else None
                page.fill("#q", q); page.wait_for_timeout(350)
                names = page.locator(".card .meta strong").all_inner_texts()
                check(names == [expect], f"{q!r} -> {names}")

        @step("custom field lifecycle: add product-level Weight, set value, rename keeps it, delete removes it")
        def _():
            go("#/manage/fields"); page.wait_for_selector("#nf-name")
            page.fill("#nf-name", "Weight"); page.select_option("#nf-type", "number"); page.select_option("#nf-scope", "product"); page.fill("#nf-unit", "kg")
            page.get_by_role("button", name="Add field").click(); toast_has("Field added")
            go("#/"); page.fill("#q", "steel"); page.wait_for_timeout(300)
            page.locator(".cardlink").first.click(); page.wait_for_selector("#photos-h")
            page.get_by_label("Weight (kg)").fill("2.5")
            page.get_by_role("button", name="Save changes").click(); toast_has("Saved")
            page.reload(); page.wait_for_selector("#photos-h")
            eq(page.get_by_label("Weight (kg)").input_value(), "2.5")
            go("#/manage/fields"); page.wait_for_selector(".list")
            row = page.locator(".list li", has_text="Weight")
            check("used 1 time" in row.inner_text(), row.inner_text())
            row.get_by_role("button", name="Edit").click()
            page.locator(".edit-form input[aria-label='Field name']").fill("Mass")
            page.get_by_role("button", name="Save", exact=True).click(); toast_has("Field updated")
            check("used 1 time" in page.locator(".list li", has_text="Mass").inner_text(), "rename must keep values")
            dialogs.clear()
            page.locator(".list li", has_text="Mass").get_by_role("button", name="Delete").click()
            toast_has("Field deleted")
            check(any("its 1 saved value" in d for d in dialogs), dialogs)
            eq(page.locator(".list li", has_text="Mass").count(), 0)

        @step("change field type with data loss: warns first, Cancel keeps the data, OK deletes only unconvertible values")
        def _():
            go("#/manage/fields"); page.wait_for_selector("#nf-name")
            page.fill("#nf-name", "Colour"); page.select_option("#nf-type", "text"); page.select_option("#nf-scope", "product")
            page.get_by_role("button", name="Add field").click(); toast_has("Field added")
            go("#/"); page.locator(".cardlink", has_text="Steel cup").click(); page.wait_for_selector("#photos-h")
            page.get_by_label("Colour").fill("silver")
            page.get_by_role("button", name="Save changes").click(); toast_has("Saved")
            go("#/manage/fields"); page.wait_for_selector(".list")
            row = page.locator(".list li", has_text="Colour")
            check("used 1 time" in row.inner_text(), row.inner_text())
            row.get_by_role("button", name="Edit").click()
            page.locator(".edit-form select").select_option("number")
            dialogs.clear(); dialog_accept[0] = False
            page.get_by_role("button", name="Save", exact=True).click(); page.wait_for_timeout(400)
            check(any("1 of 1 existing values cannot be converted" in d and "DELETED" in d for d in dialogs), str(dialogs))
            go("#/manage/fields"); page.wait_for_selector(".list")
            t = page.locator(".list li", has_text="Colour").inner_text()
            check("Text" in t and "used 1 time" in t, "Cancel must change nothing: " + t)
            dialog_accept[0] = True
            page.locator(".list li", has_text="Colour").get_by_role("button", name="Edit").click()
            page.locator(".edit-form select").select_option("number")
            page.get_by_role("button", name="Save", exact=True).click(); toast_has("Field updated")
            t = page.locator(".list li", has_text="Colour").inner_text()
            check("Number" in t and "used 0 times" in t, t)

        @step("categories and tags: rename keeps links, delete only unassigns (products stay)")
        def _():
            go("#/manage/categories"); page.wait_for_selector(".list")
            row = page.locator(".list li", has_text="Kitchen")
            check("2 products" in row.inner_text(), row.inner_text())
            row.get_by_role("button", name="Rename").click()
            page.locator(".edit-form input").fill("Kitchenware"); page.get_by_role("button", name="Save", exact=True).click(); toast_has("Renamed")
            check("2 products" in page.locator(".list li", has_text="Kitchenware").inner_text())
            page.locator(".list li", has_text="Kitchenware").get_by_role("button", name="Delete").click(); toast_has("Category deleted")
            go("#/"); page.wait_for_selector(".card")
            check(page.locator(".card").count() >= 3, "products must survive category deletion")

        @step("object URLs are freed when a screen closes (no leak)")
        def _():
            go("#/"); page.wait_for_function("[...document.querySelectorAll('.card img')].every(i=>i.complete&&i.naturalWidth>0)")
            page.get_by_role("link", name="Manage").click(); page.wait_for_selector("h1:has-text('Manage')")
            u = page.evaluate("window.__urls")
            eq(u["created"] - u["revoked"], 0, f"created={u['created']} revoked={u['revoked']}; outstanding")

        @step("delete product removes it, its photos and nothing else (with confirmation)")
        def _():
            go("#/"); page.fill("#q", "double tap"); page.wait_for_timeout(300)
            page.locator(".cardlink").first.click(); page.wait_for_selector("#photos-h")
            dialogs.clear()
            page.get_by_role("button", name="Delete product").click(); toast_has("Product deleted")
            check(any("Delete \"Double tap test\"" in d for d in dialogs), dialogs)
            go("#/"); page.wait_for_selector(".card")
            names = page.locator(".card .meta strong").all_inner_texts()
            check("Double tap test" not in names and "Steel cup" in names, str(names))

        @step("everything survives a full reload; layout fits the phone width on every screen")
        def _():
            page.goto(BASE); page.wait_for_selector(".card")
            page.fill("#q", "cup"); page.wait_for_timeout(300)
            check("Steel cup" in page.locator(".card .meta strong").all_inner_texts())
            for h_ in ["#/", "#/product/new", "#/manage/fields", "#/manage/categories"]:
                go(h_); check(no_overflow(), "overflow at " + h_)

        @step("unknown page shows a friendly message; missing product/photo links do not crash")
        def _():
            go("#/nope"); page.wait_for_selector("text=Page not found")
            go("#/product/does-not-exist"); page.wait_for_selector("text=Product not found")
            go("#/"); page.locator(".cardlink").first.click(); page.wait_for_selector("#photos-h")
            base = page.url
            page.goto(base + "/image/missing-id"); page.wait_for_selector("text=That photo no longer exists", state="attached")

        @step("no JavaScript errors were logged during the whole run")
        def _():
            check(not errors, "; ".join(errors[:4]))

        browser.close()
finally:
    server.terminate()

failed = [r for r in results if not r[0]]
print(f"\nUI run: {len(results) - len(failed)}/{len(results)} steps passed")
sys.exit(1 if failed else 0)
