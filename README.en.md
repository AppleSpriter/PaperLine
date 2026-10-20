# PaperLine

English · [简体中文](README.md)

PaperLine is a local research-learning workspace. Papers provide evidence for **shared methods and concepts**. **Model-family paths** organize independent stages, with papers and method contributions recorded under each stage. Research paths preserve existing knowledge and learning records.

## Native macOS desktop app (0.3.13)

Version 0.3.13 expands idea-graph search to method names, aliases, definitions, core mechanisms, and personal thoughts. Separate keywords with spaces, commas, or semicolons to match all terms across fields while keeping the selected method and its draft.

Version 0.3.12 moves method editing and notes to the right sidebar in the idea graph. Selecting a method opens its editor; paper and reading-path selections show their own details, while drafts and existing relationships are preserved.

Version 0.3.11 replaces the existing-card dropdown with a searchable card picker. Inspect names, types, status, and summaries, then add several cards consecutively. Added cards are clearly marked; card contents and stage contributions are preserved.

Version 0.3.10 presents methods at the top of the idea graph as browsable cards with titles, types, status, and summaries. The method catalog scrolls vertically and retains its position after selection. This display update preserves the existing save format and relationships.

Version 0.3.9 lets new idea cards join model-family paths and shows path-level cards beneath the evolution timeline. These cards do not imply stage contributions. Existing save files use the same schema without migration.

Version 0.3.8 supports papers, web pages, and models as stage materials. Search existing papers or create and edit local web/model entries and annotate their methods. Web pages require a source URL; models may omit it. Type, URL, and description survive backups and Obsidian export; web/model entries stay out of the paper citation map.

Version 0.3.7 opens method details and editing on a single click. Double-click a timeline method or choose Open method graph to enter its full graph.

Version 0.3.6 keeps navigation visible while scrolling, adds path reorder buttons, and removes surplus page height after zoom. Methods added from a stage paper appear in that stage; existing relationships can be added without changing their evidence or source.

Stage dates use an in-app calendar that follows page zoom; dates can also be typed directly.

Version 0.3.5 presents type, status, and other fixed choices as visible buttons. Add several papers to a stage consecutively, then close the picker when finished.

Version 0.3.5 strengthens recovery: cloud restore checks for local edits made during download; when primary state is corrupt, recovery is offered only for a valid backup and preserves the corrupt file for inspection. Drafts stay with their editing target, repeated saves do not create duplicates, requests over 20 MB keep the backend session alive, and failed backup writes preserve the previous file.

The native app uses Tauri 2 and the macOS WebView. Its bundled Python backend communicates over standard input/output and opens no local HTTP port. Installed users need no Python, Node.js, or source checkout. Reopening focuses the existing window; closing the window exits the backend.

On macOS 13 or later, install from the DMG into `/Applications/PaperLine.app` and launch only that installed copy. Quit the previous app normally before upgrading. The repository-root `PaperLine.app` remains the older browser launcher; build or version-directory bundles are not additional installation entry points.

Native data lives in `~/Library/Application Support/io.github.applespriter.paperline/`, independently of the application location. Use Settings to import the old `data/state.json` or a JSON backup exported by the browser version. Mac 0.3 uses schema 2: first startup reads the same-directory legacy `state.json` without changing it, writes a separate `state-v2.json`, and reuses v2 on later starts. Backup saving, vault selection, and confirmations use system dialogs. Paper and Zotero links open in the browser or Zotero.

Building requires an Apple Silicon Mac, Xcode Command Line Tools, Node.js/npm, stable Rust, and Python 3.10+. Scripts reuse `.desktop-tools/cargo/bin`, `.desktop-tools/rustup`, and `.desktop-tools/venv` when available. Otherwise they use Rust/Python from PATH and create the packaging environment in `.desktop-tools/venv`.

```bash
npm ci
npm run desktop:package
```

Artifacts in `dist/macos/0.3.13/`: `PaperLine_0.3.13_aarch64-apple-darwin.dmg` and a compressed `.app.zip`. No launchable version-directory app is retained; the temporary build bundle is removed after package verification. The DMG is created headlessly with `hdiutil` and contains the app plus an Applications shortcut. Use `npm run desktop:dev` for development. Only `static/` and the standalone backend are bundled; local `data/`, WebDAV credentials, and logs are excluded. The first build downloads Cargo dependencies and PyInstaller. A prebuild gate checks the Python executable and shared library deployment targets against macOS 13.0. Select a compatible interpreter with `PAPERLINE_PYTHON=/path/to/python3.13 npm run desktop:package`; recreate `.desktop-tools/venv` first if it uses a different interpreter. Builds use local ad-hoc signing with Hardened Runtime enabled. Because the bundled Python libraries have no Team ID, the sole runtime exception is `disable-library-validation`; Tauri applies one entitlement file to the main executable and sidecar. Packaging verifies startup, API responses, and shutdown of the signed backend inside the completed app. Public distribution requires Developer ID signing and Apple notarization.

macOS builds remap local Rust build paths to a generic `/build` prefix and audit backend archive privacy before packaging.

For development deployment, run `python3 scripts/install-macos.py /Volumes/PaperLine/PaperLine.app`. The script verifies bundle identity and signatures, requires PaperLine to quit normally, archives the existing installed app under `.desktop-build/install-backups/`, and atomically replaces `/Applications/PaperLine.app`. Failed post-install signature verification rolls back the replacement. AppSupport, Keychain, Obsidian, and the older browser launcher remain untouched. To recover, extract the old bundle with `ditto -x -k <backup.zip> <temporary-directory>` and pass it to the same installer.

## Windows desktop (0.3.0)

Mac and Windows versions are independent: Mac is 0.3.13 and Windows is 0.3.0. Windows uses the shared timeline, model-stage, global-method, and paper-search implementation. Its effective version comes from `src-tauri/tauri.windows.conf.json`.

Targets Windows 10/11 x64. The NSIS installer installs for the current user and offers English or Simplified Chinese. Installed users need no Python or Node.js. If WebView2 is missing, the installer downloads Microsoft's bootstrapper, so initial installation may need an internet connection. Data lives in `%APPDATA%\io.github.applespriter.paperline\`, separate from the installation directory. Import an existing JSON backup through Settings.

On Windows, install Python 3.13 x64, Node.js/npm, stable Rust MSVC, and Visual Studio Build Tools with Desktop development with C++ and a Windows SDK. Run in PowerShell from the repository:

```powershell
npm ci
npm run desktop:windows:package
```

To select Python, set `$env:PAPERLINE_PYTHON = "C:\path\to\python.exe"` first. The scripts use `.desktop-tools/venv-windows`, build `paperline-backend-x86_64-pc-windows-msvc.exe`, and exercise its stdin/stdout protocol with temporary data. Real `data/`, account settings, and logs are excluded. Outputs are `dist/windows/0.3.0/PaperLine_0.3.0_x64-setup.exe` and `SHA256SUMS.txt`. Use `npm run desktop:windows:dev` for development. Build the backend on Windows; macOS PyInstaller output cannot substitute for a Windows executable.

`.github/workflows/windows-desktop.yml` runs Node, Python, and Rust tests, then audits the Python archive and native executable for private build paths before packaging NSIS. On its dedicated runner, installation checks install the published 0.2.1 release into a path containing Chinese characters and spaces, create synthetic v1 notes in the default `%APPDATA%` directory, and upgrade to 0.3.0. Checks cover read-only v1 migration, manual method/stage contributions, reading history, byte-for-byte retention through replacement installation and uninstall, a real window, graceful exit, and descendant cleanup. The synthetic default-data directory must not exist before testing and is removed afterwards. No real Zotero/WebDAV credentials are used. Passing installers and checksums are uploaded as GitHub Actions artifacts; the workflow does not publish a Release.

Windows 0.3.0 requires a successful run of this workflow before its installer is considered validated. [The historical 0.2.1 CI run](https://github.com/AppleSpriter/PaperLine/actions/runs/38501863099) does not validate 0.3.0. Draft serialization and restoration are covered by JavaScript tests; native WebView draft persistence, Zotero, directory selection, backup saving, and complete UI behavior still need Windows device checks. No Windows code-signing certificate is configured, so an unsigned installer may trigger SmartScreen. Reference: [Tauri's Windows installer guide](https://v2.tauri.app/distribute/windows-installer/).

## Browser version

Requires Python 3.10 or newer. No packages need to be installed.

The repository’s older browser launcher and `stop.command` remain for source compatibility; they are not installation or everyday launch entry points for Mac 0.3. Launch the native app only from `/Applications/PaperLine.app`.

Alternatively, double-click `start.command` to run the server in a Terminal window; closing that window stops it. On other systems, run this from the project folder:

```bash
python3 app.py
```

The app opens at `http://127.0.0.1:8765`.

**Help** in the top right opens the full in-app guide: the concepts, the five first steps, Zotero and Obsidian setup, and the shortcuts.

## Get started

Model-family paths show a timeline of stage dates, papers, and method-contribution links. Search imported papers in the library before opening a paper or adding it to a stage. Methods are global shared entities: papers and stages reference the same method, so edits remain consistent across views.

1. Create a reading path around a research question.
2. **Search** covers reading paths, idea cards, and papers in one box. Results carry a coloured left bar and tag for their type (green for idea cards, blue for reading paths, purple for papers) and open the matching view on click; a status filter narrows results to idea cards. The creation form also suggests similar cards. Cards can have aliases and belong to several paths.
3. Search your local Zotero library under **Papers** and import a paper, or add one manually. You can load text annotations and create cards from them.
4. Connect several papers to the same card. Record how each paper uses the idea and link to the relevant passage. Use **New branch** when a new question comes up; the card is connected to its source idea automatically.
5. Start a reading session. Before finishing, write two sentences in your own words and leave a question for next time. The previous note appears when you reopen the card.
6. Set your Obsidian vault path under **Settings**, then choose **Export to Obsidian**.

You can switch the interface between Simplified Chinese and English in **Settings**. You can also set a daily reminder. In-app reminders work while the page is open; browser notifications require separate permission.

Card edits are kept as drafts when you switch cards or reload the page. **Continue later** keeps your reading time and notes; open the same card again to resume without counting the break. Drafts are stored in the current browser. Choose **Save card** or **Save reading session** to include them in app data, backups, and exports.

Card type and status are button rows: one click saves them right away, with no need to choose **Save card**. Text fields still behave as drafts.

In the reading path view, use ↑ and ↓ on each row to set the learning order. Each card adds up its reading time: the card details show the total and the number of sessions, and the reading path shows the total for the whole path.

With two pages open, switching back loads the latest data. If a card was changed elsewhere, saving warns you and loads the newer version while keeping your text as a draft; save again to overwrite.

The paper map’s year mode groups papers into year columns and connects them into a citation timeline; another mode sorts by citations from library papers. Selecting a paper shows three columns: its references on the left, the selected paper in the middle, and its citers on the right. **Back to library** restores the previous sort. Details stay in the side panel on desktop and open in a drawer on narrow screens. Recommendations require reference evidence from at least two library papers. Older data rebuilds recommendations from saved citation links and reference text without another Zotero sync.

Inside the paper map or idea graph, hold Command on macOS or Ctrl on Windows and use the mouse wheel to zoom (15%–200%) around the pointer. Ordinary wheel input still scrolls.

The top-right Page controls zoom the whole interface from 70% to 150%; click the percentage to reset to 100%. The setting is saved on this device and remains independent of graph zoom.

## Deleting and shortcuts

- Idea card: **Delete this idea card** at the bottom of the details panel. Its paper connections, idea connections, and reading sessions go with it.
- Paper: **Delete this paper** at the bottom of the details panel. Only its connections are removed; the idea cards stay.
- Reading path: **Delete reading path** inside the **Edit reading path** dialog. Idea cards, papers, and reading sessions are kept.
- After deletion, the next export moves the corresponding previously owned Obsidian note into the vault’s `.trash/PaperLine/`. Its full text, including manual additions, remains recoverable. Unrelated handwritten notes are left intact.
- Shortcuts (no dialog open, focus outside a text field): `1`–`4` switch between idea graph, reading path, search, and papers; `n` new idea card; `p` add paper; `l` new reading path; `s` start reading the current card; `/` jump to search; `?` open the in-app guide.

Keep Zotero running and enable **Allow other applications on this computer to communicate with Zotero** under Zotero's advanced settings. PaperLine only reads Zotero's local API and does not modify your Zotero library.

## Data and Obsidian export

Model-family reading paths link stages with a title, date, and summary. Reading records can target a stage while legacy card targets remain supported. Migration packages include validated stage, annotation, form, and timer drafts alongside existing card/session drafts. Cloud schema 2 writes `state-v2.json` and preserves legacy cloud `state.json`.

- App data is stored in `data/state-v2.json`. Git ignores the `data/` directory.
- Before each write, the previous data is copied to `data/state-v2.backup.json`. If the main file is damaged, PaperLine changes nothing and points you to that backup.
- **Settings → Back up data** downloads a complete JSON backup, and **Restore from backup** replaces the current data with a backup file. The file's format and references are checked first, and the current data is saved as `data/state-v2.before-restore-TIME.json`. The Obsidian path, language, and reminder stay as set on this machine. Files from the WebDAV `history-v2/` folder can be restored the same way.

## WebDAV sync

- Under **Settings → WebDAV sync**, enter the address, username, password, and cloud folder, tick **Upload to WebDAV automatically**, and choose **Test connection** to confirm it can write.
- Once enabled, `state-v2.json` is uploaded to the cloud folder once every 5 minutes while there are changes (counted from the first change, so everything within those 5 minutes goes up together; nothing is uploaded when nothing changed), and one `history-v2/state-v2-YYYY-MM-DD.json` is kept per day. Failed uploads retry after 1, 2, 4… up to 15 minutes; PaperLine also uploads once at startup and before a normal shutdown.
- The top bar shows **Synced / Pending / Sync failed**; click it to open Settings and see why. **Sync now** uploads by hand.
- For Jianguoyun use `https://dav.jianguoyun.com/dav/` with an app password generated in its dashboard. Nextcloud is usually `https://your-domain/remote.php/dav/files/USERNAME/`.
- Credentials live separately in `data/webdav.json` (mode 600) and never enter `state-v2.json`, the backup download, or the browser. An empty password field keeps the saved one; changing the address or username requires entering it again.
- Every save records its time as `savedAt`. Settings show when this machine and the cloud were last saved, and which one is newer.
- Main-file uploads use conditional writes: creation requires the cloud file to remain absent, and replacement requires a strong ETag matching the version just read. Concurrent changes stop the upload with a conflict. When different cloud content lacks a strong ETag, even a manually confirmed overwrite stops conservatively; restore from cloud or choose an empty sync location. Importing a legacy backup requires explicit confirmation before first replacing different v2 cloud content.
- Before uploading, the two times are compared. If the cloud is newer (for example, another computer just uploaded), automatic upload pauses and the top bar shows **Cloud newer** instead of overwriting the cloud.
- Choose **Restore from cloud** and confirm to replace the data here with the cloud copy; the current data is saved as a separate pre-restore backup first. After restoring, both sides match and automatic upload carries on.
- Or choose **Sync now** and confirm to overwrite the cloud with this machine; the overwritten cloud copy is saved as `history-v2/state-v2-overwritten-TIME.json` first.
- If this machine is newer, **Restore from cloud** warns that it would replace newer data with older data. Nothing is restored when both sides match. The Obsidian path, language, and reminder always stay as set on this machine.
- Cloud files uploaded by older versions have no `savedAt` and are compared by the server's modification time. If the two computers' clocks differ a lot, the comparison can be wrong.
- Changes from both sides are never merged: when both computers changed, keep one side, and the other stays as a copy in `history-v2/` or `data/`. Prefer https; http sends the password unencrypted.
- Notes are exported to `PaperLine/` inside your chosen Obsidian vault. It contains folders for reading paths, idea cards, papers, and model stages. Folder names stay in Chinese so links remain stable when you switch languages.
- Exported notes contain no HTML ownership markers. `PaperLine/.paperline-export.json` records generated content; later exports replace its exact, unique previous text and preserve handwritten additions before and after it. Legacy marked notes migrate automatically. If generated text was edited, duplicated, or ownership of a same-named file is unknown, the entire export stops before writing and identifies the conflict. Keep the hidden record file.
- Notes whose content did not change are skipped instead of rewritten, so Obsidian sync does not re-upload the whole vault. The result reports how many notes were written and how many were skipped.
- A note file name is derived from the title when the item is created and stays fixed when you rename it, so existing Obsidian links keep working. The title inside the note is updated.
- A newly exported paper note includes sections for a one-sentence summary, problem, core mechanism, thoughts, techniques, relationship to other methods, limitations, and the paper/report. New section headings follow your selected language. Existing handwritten sections are preserved when you switch languages.

PaperLine binds only to `127.0.0.1`. It needs no account or cloud service. The graph and reading timer run locally.

## Verify

```bash
python3 -m unittest discover -s tests -v
node --check static/app.js
node --check static/i18n.js
node --test tests/*.test.js
```
