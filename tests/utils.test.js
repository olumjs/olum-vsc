/**
 * Shared helpers, plus the packaged configuration the extension ships:
 * snippets, language configuration, and the colour settings in package.json.
 */

const fs = require("fs");
const path = require("path");
const { section, test, testAsync, eq, ok, vscode, Doc, OUT } = require("./harness");
const { isPascalCase, isHtmlTagName, escapeRegExp } = require(OUT + "/utils/helpers");
const { rangeFromOffsets, offsetAt } = require(OUT + "/utils/ranges");
const { createKeyedDebouncer } = require(OUT + "/utils/debounce");
const { getColors } = require(OUT + "/utils/colors");
const { createDecorations, disposeDecorations } = require(OUT + "/highlighting/decorations");

const ROOT = path.join(__dirname, "..");
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function run() {
  // ── predicates ─────────────────────────────────────────────────────────────
  section("utils › predicates");

  test("isPascalCase", () => eq(
    ["Header", "H", "HeaderBar", "header", "hEader", "_H", "", "Header-Bar"].map(isPascalCase),
    [true, true, true, false, false, false, false, false],
  ));

  test("isHtmlTagName knows real elements", () => eq(
    ["button", "header", "form", "label", "main", "dialog", "progress", "meter", "input", "table"].map(isHtmlTagName),
    [true, true, true, true, true, true, true, true, true, true],
  ));

  test("isHtmlTagName rejects component names", () => eq(
    ["card", "modal", "navbar", "sidebar", "myWidget"].map(isHtmlTagName),
    [false, false, false, false, false],
  ));

  test("escapeRegExp neutralises metacharacters", () => {
    const spec = "./a+b(c)";
    return ok(new RegExp(escapeRegExp(spec)).test(spec));
  });

  // ── ranges ─────────────────────────────────────────────────────────────────
  section("utils › offsets and ranges");

  test("offsets convert to line/character", () => {
    const doc = new Doc("ab\ncdef\ngh");
    const r = rangeFromOffsets(doc, 4, 6);
    return eq([r.start.line, r.start.character, r.end.line, r.end.character], [1, 1, 1, 3]);
  });

  test("the round trip is stable", () => {
    const doc = new Doc("ab\ncdef\ngh");
    return eq(offsetAt(doc, doc.positionAt(6)), 6);
  });

  test("a range extracts the text it covers", () => {
    const doc = new Doc("hello world");
    return eq(doc.getText(rangeFromOffsets(doc, 6, 11)), "world");
  });

  // ── debounce ───────────────────────────────────────────────────────────────
  section("utils › keyed debouncer");

  await testAsync("only the last call in a burst runs", async () => {
    const d = createKeyedDebouncer(20);
    let runs = 0;
    d.schedule("a", () => runs++);
    d.schedule("a", () => runs++);
    d.schedule("a", () => runs++);
    await wait(60);
    d.dispose();
    return eq(runs, 1);
  });

  await testAsync("different keys do not cancel each other", async () => {
    const d = createKeyedDebouncer(20);
    const seen = [];
    d.schedule("a", () => seen.push("a"));
    d.schedule("b", () => seen.push("b"));
    await wait(60);
    d.dispose();
    return eq(seen.sort(), ["a", "b"]);
  });

  await testAsync("dispose cancels pending work", async () => {
    const d = createKeyedDebouncer(20);
    let runs = 0;
    d.schedule("a", () => runs++);
    d.dispose();
    await wait(60);
    return eq(runs, 0);
  });

  // ── colours and decorations ────────────────────────────────────────────────
  section("utils › colours and decorations");

  test("every configured colour has a value", () => {
    const colors = getColors();
    return ok(Object.keys(colors).length > 0)
      && ok(Object.values(colors).every((c) => /^#[0-9a-fA-F]{3,8}$/.test(c)));
  });

  test("a decoration type exists for every colour", () => {
    const set = createDecorations(getColors());
    const buckets = ["comp", "flow", "propName", "propEq", "strQuote", "str",
      "brace", "num", "kw", "nullish", "varVal", "forLocal"];
    const okAll = buckets.every((b) => set[b]);
    disposeDecorations(set);
    return ok(okAll);
  });

  test("package.json declares a setting for every colour bucket", () => {
    const declared = Object.keys(readJson("package.json").contributes.configuration.properties);
    const colorKeys = declared.filter((k) => k.startsWith("olum.colors."));
    return eq(colorKeys.length, Object.keys(getColors()).length);
  });

  // ── packaged configuration ─────────────────────────────────────────────────
  section("config › packaged files");

  test("snippets file is valid JSON with bodies and prefixes", () => {
    const raw = fs.readFileSync(path.join(ROOT, "snippets/snippets.code-snippets"), "utf8");
    const snippets = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""));
    const entries = Object.values(snippets);
    return ok(entries.length > 0)
      && ok(entries.every((s) => s.prefix && s.body));
  });

  test("a snippet exists for every flow tag that takes one", () => {
    const raw = fs.readFileSync(path.join(ROOT, "snippets/snippets.code-snippets"), "utf8");
    const bodies = JSON.stringify(JSON.parse(raw.replace(/^\s*\/\/.*$/gm, "")));
    const { FLOW_TAG_NAMES } = require(OUT + "/parser/types");
    const missing = FLOW_TAG_NAMES.filter((t) => !bodies.includes(`<${t}`));
    return eq(missing, []);
  });

  test("language configuration is valid JSON with the expected pairs", () => {
    const cfg = readJson("language-configuration.json");
    const pairs = JSON.stringify(cfg.autoClosingPairs || []);
    return ok(pairs.includes("{")) && ok(pairs.includes("["));
  });

  test("package.json points at a compiled entry point that exists", () => {
    const pkg = readJson("package.json");
    return ok(fs.existsSync(path.join(ROOT, pkg.main)));
  });

  test("every contributed command is registered by the extension", () => {
    const pkg = readJson("package.json");
    const declared = pkg.contributes.commands.map((c) => c.command);
    const source = fs.readFileSync(path.join(ROOT, "src/extension.ts"), "utf8");
    return ok(declared.every((id) => source.includes(`"${id}"`)));
  });

  test("the scss grammar injection file is valid JSON", () => {
    const pkg = readJson("package.json");
    for (const g of pkg.contributes.grammars) readJson(g.path);
    return true;
  });
};
