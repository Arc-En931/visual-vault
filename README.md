# VisualVault

A private image catalog that lives entirely on your device. It is a static web app (plain HTML, CSS and JavaScript
modules, no build step, no server code) that installs as an offline PWA. Your products and photos are stored in the
browser's IndexedDB and are never uploaded anywhere.

To put it on an Android phone, follow **[INSTALL.md](INSTALL.md)**. This file is for people who run, test or change the code.

## What it does

- **Products** with a name, SKU, description and notes, any number of photos each, categories and tags.
- **Custom fields** you define yourself (text, number, date, yes/no, money). A field belongs either to the product
  or to each individual photo (for example a per-photo price).
- **Photos** from the gallery or camera. The real file type is read from the bytes (JPEG, PNG, WebP, GIF), a thumbnail is
  made, and photos can be replaced, retaken, reordered or deleted.
- **Search, filter and sort** over everything: names, SKU, text, captions, field names and values, categories and tags.
  Every word must match; matching is partial, case-insensitive and accent-insensitive. Number, money, date and yes/no
  fields can be filtered, and number, money and date fields can be sorted on.
- **Offline**: after the first visit with a connection, the app opens and works with no connection.
- **Backup and restore** (Manage → Backup): one ZIP with everything, validated completely before any restore.

## Running it

Any static file server works, but the page must be served from `http://localhost` or `https://` (service workers and
SHA-256 do not work from `file://`).

```sh
cd visualvault
python3 -m http.server 8000
# open http://localhost:8000
```

## Testing

Needs Python 3, [Playwright for Python](https://playwright.dev/python/) with Chromium, and Pillow. The runners expect
Chromium at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`; set `CHROME_PATH` to use another binary.

```sh
python3 tests/run-all.py        # static checks + every suite, one summary, exit code 1 on any failure
```

| Command | What it covers | Result at hand-off |
| --- | --- | --- |
| `python3 tools/check.py` | JS syntax, `tsc` type check (undefined names, unused variables), Python compile and unused imports, whitespace, `sw.js` stamp | clean |
| `python3 tests/run-headless.py` | Unit and integration tests against real IndexedDB, plus a full browser close and reopen persistence check | 86/86 |
| `python3 tests/run-ui.py` | Every screen driven through the real UI, phone-width layout, no JavaScript errors | 29/29 |
| `python3 tests/run-pwa.py` | Offline start, install files, update flow, failure fallbacks (server really stopped, `no-store`) | 24/24 |
| `python3 tests/run-backup.py` | Backup download verified independently with Python (`zipfile`, `hashlib`, PIL), restore in a new browser profile, refusal of damaged or foreign files | 16/16 |

`tests/index.html` runs the in-browser suites by hand: serve the folder and open `/tests/`.

The tests were checked by **mutation**: the code was deliberately broken (for example: ignore "skip existing", skip
checksum verification, write non-atomically, accept `../` names) and each break had to make a test fail. The static
checker was checked the same way (planted syntax error, undefined name, unused variable and trailing whitespace).

`tools/check.py` needs `tsc` for the type check (`npm i -g typescript`); without it that step is skipped with a notice. There
is **no auto-formatter** in the toolchain, so formatting is enforced as rules (whitespace) and not rewritten by a tool.
Lines of up to about 200 characters are accepted; a few CSS one-liners and typed signatures are longer.

## Before every deploy

```sh
python3 tools/stamp-sw.py       # updates the version in sw.js from the content of every precached file
python3 tools/check.py          # fails if the stamp is stale or a file is missing from PRECACHE
```

Phones only notice a new version if `sw.js` changed, which is what the stamp does. A **new** app file must also be added to
`PRECACHE` in `sw.js`, otherwise it will not work offline (the stamp tool and `run-pwa.py` both fail if you forget).
Deploy `index.html`, `sw.js`, `manifest.webmanifest`, `.nojekyll`, `css/`, `js/` and `icons/`. `tests/`, `tools/`,
`tsconfig.check.json` and the Markdown files are optional.

## How it is built

| File | Responsibility |
| --- | --- |
| `js/app.js` | Router (hash routes), toasts, startup, service worker registration |
| `js/db.js` | Opens IndexedDB, versioned additive migrations, storage estimate and persistence request |
| `js/models.js` | Validation, field types, value coercion, error type |
| `js/repository.js` | All reads and writes. Multi-record changes run in a single transaction; products carry a revision for edit-conflict detection |
| `js/search-service.js` | Pure in-memory search, filter and sort over a snapshot (no DOM, no IndexedDB) |
| `js/image-service.js` | Type sniffing, size limits, thumbnails, object-URL tracking |
| `js/zip.js` | ZIP writer and strict reader (STORE only, CRC-32, rejects unsafe names and truncation) |
| `js/backup.js` | Builds the backup, validates a backup completely and returns a clean copy |
| `js/views/*.js` | Screens: catalog, product form, photo editor, manage (fields, categories, tags, backup) |
| `sw.js`, `js/pwa.js` | Offline precache and the update prompt |

Design rules worth keeping:

- The UI never touches IndexedDB directly; it goes through the repository.
- Anything that must be all-or-nothing is one transaction, and a restore recomputes its plan **inside** that transaction,
  so the preview shown to the user and what is committed cannot disagree.
- A backup is validated in full before anything is written, and unknown properties in it are never copied into the catalog.
- Database changes are additive migrations (`DB_VERSION` in `db.js`); existing data stays in place.

### Backup format

A plain ZIP (stored, not compressed): `manifest.json` (every file's size and SHA-256), `data.json` (all records),
`images/` and `thumbs/` (the photos). Because it is a standard ZIP, it can be opened with any tool for inspection. If it is
re-saved by a tool that compresses it, the app refuses it and says why.

## Known limitations

### Not tested

- Real devices: Android Chrome (install prompt, download dialog, Downloads folder) and iOS Safari were **not** tested. All
  automated runs use headless Chromium on a desktop. Other browser engines (Firefox, Safari) were not run at all.
- Catalogs larger than the performance test (300 products × 3 photos, 3.4 MB). Multi-gigabyte catalogs are untested.
  Desktop timings for that case were: export 2.5 s, validate 3.7 s, restore 1.4 s. Phones will be slower, mainly because
  the CRC is computed in JavaScript.

### Data safety

- Data lives only in the browser. Clearing site data, or sometimes uninstalling the app, deletes the catalog. The app
  asks the browser for protected storage, but that is a request, not a guarantee (Manage shows whether it was granted).
- Nothing enforces that a backup leaves the phone; the page only says to copy it off.
- There is no sync between devices and no accounts.

### Photos

- HEIC photos are refused with an explanation (use JPEG, PNG, WebP or GIF). Photos are limited to 30 MB each and
  about 120 megapixels once decoded.

### Backup and restore

- Archives of 4 GB or more are refused (no ZIP64).
- **Skip existing** matches by product id only. A product you edited after the backup was made is not updated from it, and
  restore never deletes or overwrites existing products or photos.
- A same-name field with a different type, when the existing field already holds values, stops the restore; one of
  them has to be renamed first.
- App settings are not part of a backup.
- Creating or checking a backup needs SHA-256, which needs a secure page (https or localhost); GitHub Pages is one.
- A backup written by a newer version of the app cannot be opened by an older one.

### Updates

- A new version is picked up only when the app is opened with a connection; the user then chooses **Update now** or
  **Later**. Until then the old version keeps working.

### Tooling

- No eslint or prettier (not installable in the build environment). The type check covers undefined names and unused
  variables, but it is not a style linter.
