# PaperLine

English · [简体中文](README.md)

PaperLine is a lightweight, local app for reading research papers. **Reading paths** give you a next step, **idea cards** collect the same idea across multiple papers, and a graph shows which papers propose, use, improve, or question an idea.

## Run

Requires Python 3.10 or newer. No packages need to be installed.

```bash
python3 app.py
```

The app opens at `http://127.0.0.1:8765`. On macOS, you can also double-click `start.command`. Close the terminal running the app to stop it.

## Get started

1. Create a reading path around a research question.
2. Add an idea card, such as GRPO. A card can belong to several paths.
3. Search your local Zotero library under **Papers** and import a paper, or add one manually. You can load text annotations and create cards from them.
4. Connect several papers to the same card. Record how each paper uses the idea and link to the relevant passage.
5. Start a reading session. Before finishing, write two sentences in your own words. Continue from the same card next time.
6. Set your Obsidian vault path under **Settings**, then choose **Export to Obsidian**.

You can switch the interface between Simplified Chinese and English in **Settings**. You can also set a daily reminder. In-app reminders work while the page is open; browser notifications require separate permission.

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
```
