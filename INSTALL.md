# Putting VisualVault on your Android phone

VisualVault must be opened from an **https** address (or `localhost`); Chrome will not install or run offline from a file. The simplest free way is GitHub Pages. Your catalog is never uploaded: only the app's code is hosted. Your photos and data stay on the phone.

## A. Host it (GitHub Pages, about 5 minutes, on a computer)

1. Sign in at github.com, tap **+ → New repository**. Name it e.g. `visualvault`. Choose **Public** (free Pages needs this). Create it.
2. Click **uploading an existing file**. Drag in the **contents** of the `visualvault` folder (index.html, sw.js, manifest.webmanifest, the `css`, `js`, `icons` folders, `.nojekyll`) so that `index.html` sits at the top level of the repo, not inside another folder. The `tests` and `tools` folders, `tsconfig.check.json` and the `.md` files are optional. Click **Commit changes**.
3. Open **Settings → Pages**. Under *Build and deployment*, Source = **Deploy from a branch**, Branch = **main**, folder **/ (root)**, **Save**.
4. After 1–2 minutes the page shows your address: `https://YOUR-NAME.github.io/visualvault/`. Open it on your computer first to check it loads.

(Alternative: drag the folder onto app.netlify.com/drop; it gives you an https address immediately.)

## B. Install on the phone (Chrome for Android)

1. Open Chrome and go to your address.
2. Wait a few seconds until a message says **"Ready to work offline"**. Do not skip this: it means the offline copy is saved.
3. Tap the **⋮** menu (top right) → **Install app** (on some versions: **Add to Home screen**, then **Install**). Confirm **Install**.
4. Find the VisualVault icon on the home screen / app drawer and open it. It opens full-screen without the address bar.
5. Test offline: turn on **Airplane mode**, close VisualVault, open it again from the icon. Your catalog should open.

Menu names vary a little between Chrome versions. If you see no "Install app", reload the page once and wait for the offline message again.

## C. Updating the app later

1. After changing any app file, run `python3 tools/stamp-sw.py` once (it updates the version in `sw.js`). Without this, phones will not notice the change. `python3 tests/run-pwa.py` fails if you forget.
2. Upload the changed files (including `sw.js`) to the repo.
3. On the phone, open the app with a connection. A message **"A new version of VisualVault is ready"** appears; tap **Update now** (or **Later**; it asks again next time). Nothing in your catalog is touched.

## D. Important: your data lives only in this browser

- Installing does **not** make your data safer. Chrome's **Clear browsing data → Cookies and site data**, or clearing storage for the site in Android settings, **deletes the catalog**. Uninstalling the app can also remove its data.
- Chrome usually protects installed apps from automatic cleanup, but this is not guaranteed.
- **Make backups.** Open **Manage → Backup → Download backup**. You get one `.zip` file (products, photos with thumbnails, fields, values, categories, tags). Then **copy that file out of the phone** (Drive, email to yourself, a computer). A backup that only sits in the phone's Downloads folder is lost along with the phone. The page shows when you last made one.
- Do this after any session where you added a lot, and before updating Android, clearing browser data, or uninstalling.

## E. Restoring a backup

1. Open **Manage → Backup**, tap **Backup file (.zip)** and pick the file. The app checks every file inside (checksums, photo formats, links between records) **before** touching anything. If anything is wrong it lists the problems and offers no Restore button.
2. Choose how to restore:
   - **Skip existing** (default): products that are already in the catalog (same ID) are left exactly as they are; only missing ones are added. Use this on a new phone or after losing data. Safe to repeat.
   - **Add as new**: every product in the backup is added as a new product, even if a copy exists. Restoring twice gives duplicates.
3. Read the line that says what will be added, then tap **Restore**. It is all-or-nothing: if the phone runs out of space or anything fails, nothing is changed.

Good to know:

- Restoring never deletes or overwrites your existing products or photos.
- Fields, categories and tags are matched **by name**; missing ones are created. If a backup field and an existing field have the same name but different types **and the existing one already holds values**, the restore stops and tells you which field; rename one and retry. (An unused field simply takes the backup's type; this is what happens to the starter "Price" field on a new phone.)
- App settings are not part of a backup.
- The backup is a plain ZIP (stored, not compressed). Do not re-compress it with another tool; the app will say so and refuse it.
- A backup made by a newer version of the app cannot be opened by an older one; update the app first.
