const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = resolve(__dirname, "..");
const i18nSource = readFileSync(resolve(root, "static/i18n.js"), "utf8");
const appSource = readFileSync(resolve(root, "static/app.js"), "utf8");
const htmlSource = readFileSync(resolve(root, "static/index.html"), "utf8");

// Chinese stays the source of truth, so every finished phrase shipped in the UI needs an
// English counterpart in i18n.js. Runtime-composed fragments still contain ${...} here and
// are skipped; the document title is handled by i18n.apply itself.
const chinese = /[\u4e00-\u9fff]/;
const skip = new Set(["读线 · PaperLine"]);

function loadTranslate() {
  const context = vm.createContext({
    document: { documentElement: {}, createTreeWalker: () => ({ nextNode: () => false }) },
    NodeFilter: { SHOW_TEXT: 4 },
  });
  vm.runInContext(i18nSource, context);
  return context.PaperLineI18n.translate;
}

function markupStrings(source) {
  const found = [];
  for (const [, text] of source.matchAll(/>([^<>{}]+)</g)) found.push(text);
  for (const [, , value] of source.matchAll(/\b(placeholder|aria-label|title)="([^"{}]+)"/g)) found.push(value);
  return found;
}

function quotedStrings(source) {
  const found = [];
  for (const [, value] of source.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) found.push(value);
  for (const [, value] of source.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)) found.push(value);
  return found;
}

function candidates() {
  const all = [
    ...markupStrings(htmlSource),
    ...quotedStrings(htmlSource),
    ...markupStrings(appSource),
    ...quotedStrings(appSource),
  ];
  return [...new Set(all.map((value) => value.trim()))]
    .filter((value) => chinese.test(value) && !value.includes("${") && !skip.has(value));
}

test("every Chinese string shipped in the interface has an English translation", () => {
  const translate = loadTranslate();
  const untranslated = candidates().filter((value) => chinese.test(translate(value)));
  assert.deepEqual(untranslated, [], `缺少英文词条：\n${untranslated.join("\n")}`);
});

test("the translator keeps user content and unknown text unchanged", () => {
  const translate = loadTranslate();
  assert.equal(translate("GRPO"), "GRPO");
  assert.equal(translate("  待学  "), "  To learn  ");
  assert.equal(translate("基础概念 · 正在学"), "Core concept · Learning");
});
