# PaperLine

English · [简体中文](README.md)

PaperLine is a lightweight, local app for reading research papers. **Reading paths** give you a next step, **idea cards** collect the same idea across multiple papers, and a graph shows which papers propose, use, improve, or question an idea.

## Run

Requires Python 3.10 or newer. No packages need to be installed.

**On macOS, double-click `PaperLine.app` in the project folder.** The launcher starts the local server in the background and opens your browser. If PaperLine is already running, it simply opens the page. Double-click `stop.command` to stop a server started by the app. Keep `PaperLine.app` beside `app.py` in the project folder.

Alternatively, double-click `start.command` to run the server in a Terminal window; closing that window stops it. On other systems, run this from the project folder:

```bash
python3 app.py
```

The app opens at `http://127.0.0.1:8765`.

**Help** in the top right opens the full in-app guide: the concepts, the five first steps, Zotero and Obsidian setup, and the shortcuts.

## Get started

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

## Deleting and shortcuts

- Idea card: **Delete this idea card** at the bottom of the details panel. Its paper connections, idea connections, and reading sessions go with it.
- Paper: **Delete this paper** at the bottom of the details panel. Only its connections are removed; the idea cards stay.
- Reading path: **Delete reading path** inside the **Edit reading path** dialog. Idea cards, papers, and reading sessions are kept.
- Deleting only touches app data. Notes already exported to Obsidian are left alone; remove them yourself when you want.
- Shortcuts (no dialog open, focus outside a text field): `1`–`4` switch between idea graph, reading path, search, and papers; `n` new idea card; `p` add paper; `l` new reading path; `s` start reading the current card; `/` jump to search; `?` open the in-app guide.

Keep Zotero running and enable **Allow other applications on this computer to communicate with Zotero** under Zotero's advanced settings. PaperLine only reads Zotero's local API and does not modify your Zotero library.

## Data and Obsidian export

- App data is stored in `data/state.json`. Git ignores the `data/` directory.
- Before each write, the previous data is copied to `data/state.backup.json`. If the main file is damaged, PaperLine changes nothing and points you to that backup.
- **Settings → Back up data** downloads a complete JSON backup, and **Restore from backup** replaces the current data with a backup file. The file's format and references are checked first, and the current data is saved as `data/state.before-restore-TIME.json`. The Obsidian path, language, and reminder stay as set on this machine. Files from the WebDAV `history/` folder can be restored the same way.

## WebDAV sync

- Under **Settings → WebDAV sync**, enter the address, username, password, and cloud folder, tick **Upload to WebDAV automatically**, and choose **Test connection** to confirm it can write.
- Once enabled, `state.json` is uploaded to the cloud folder once every 5 minutes while there are changes (counted from the first change, so everything within those 5 minutes goes up together; nothing is uploaded when nothing changed), and one `history/state-YYYY-MM-DD.json` is kept per day. Failed uploads retry after 1, 2, 4… up to 15 minutes; PaperLine also uploads once at startup and before a normal shutdown.
- The top bar shows **Synced / Pending / Sync failed**; click it to open Settings and see why. **Sync now** uploads by hand.
- For Jianguoyun use `https://dav.jianguoyun.com/dav/` with an app password generated in its dashboard. Nextcloud is usually `https://your-domain/remote.php/dav/files/USERNAME/`.
- Credentials live separately in `data/webdav.json` (mode 600) and never enter `state.json`, the backup download, or the browser. An empty password field keeps the saved one; changing the address or username requires entering it again.
- Every save records its time as `savedAt`. Settings show when this machine and the cloud were last saved, and which one is newer.
- Before uploading, the two times are compared. If the cloud is newer (for example, another computer just uploaded), automatic upload pauses and the top bar shows **Cloud newer** instead of overwriting the cloud.
- Choose **Restore from cloud** and confirm to replace the data here with the cloud copy; the current data is saved as `data/state.before-cloud-restore-TIME.json` first. After restoring, both sides match and automatic upload carries on.
- Or choose **Sync now** and confirm to overwrite the cloud with this machine; the overwritten cloud copy is saved as `history/state-overwritten-TIME.json` first.
- If this machine is newer, **Restore from cloud** warns that it would replace newer data with older data. Nothing is restored when both sides match. The Obsidian path, language, and reminder always stay as set on this machine.
- Cloud files uploaded by older versions have no `savedAt` and are compared by the server's modification time. If the two computers' clocks differ a lot, the comparison can be wrong.
- Changes from both sides are never merged: when both computers changed, keep one side, and the other stays as a copy in `history/` or `data/`. Prefer https; http sends the password unencrypted.
- Notes are exported to `PaperLine/` inside your chosen Obsidian vault. It contains folders for reading paths, idea cards, and papers. Folder names stay in Chinese so links remain stable when you switch languages.
- On later exports, only content between `PAPERLINE:START/END` markers is updated. Your notes outside the markers stay intact. If a same-named file has no markers, export stops and names that file instead of overwriting it.
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
