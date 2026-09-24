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

## Get started

1. Create a reading path around a research question.
2. Search the **Idea library** before creating a card. The creation form also suggests similar cards. Cards can have aliases and belong to several paths.
3. Search your local Zotero library under **Papers** and import a paper, or add one manually. You can load text annotations and create cards from them.
4. Connect several papers to the same card. Record how each paper uses the idea and link to the relevant passage. Use **New branch** when a new question comes up; the card is connected to its source idea automatically.
5. Start a reading session. Before finishing, write two sentences in your own words and leave a question for next time. The previous note appears when you reopen the card.
6. Set your Obsidian vault path under **Settings**, then choose **Export to Obsidian**.

You can switch the interface between Simplified Chinese and English in **Settings**. You can also set a daily reminder. In-app reminders work while the page is open; browser notifications require separate permission.

Card edits are kept as drafts when you switch cards or reload the page. **Continue later** keeps your reading time and notes; open the same card again to resume without counting the break. Drafts are stored in the current browser. Choose **Save card** or **Save reading session** to include them in app data, backups, and exports.

Keep Zotero running and enable **Allow other applications on this computer to communicate with Zotero** under Zotero's advanced settings. PaperLine only reads Zotero's local API and does not modify your Zotero library.

## Data and Obsidian export

- App data is stored in `data/state.json`. Git ignores the `data/` directory.
- **Settings → Back up data** downloads a complete JSON backup.
- Notes are exported to `PaperLine/` inside your chosen Obsidian vault. It contains folders for reading paths, idea cards, and papers. Folder names stay in Chinese so links remain stable when you switch languages.
- On later exports, only content between `PAPERLINE:START/END` markers is updated. Your notes outside the markers stay intact. If a same-named file has no markers, export stops to avoid overwriting it.
- A newly exported paper note includes sections for a one-sentence summary, problem, core mechanism, thoughts, techniques, relationship to other methods, limitations, and the paper/report. New section headings follow your selected language. Existing handwritten sections are preserved when you switch languages.

PaperLine binds only to `127.0.0.1`. It needs no account or cloud service. The graph and reading timer run locally.

## Verify

```bash
python3 -m unittest discover -s tests -v
node --check static/app.js
node --check static/i18n.js
node --test tests/frontend.test.js
```
