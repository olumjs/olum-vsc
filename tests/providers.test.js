/**
 * Language features driven through the registered providers, exactly as VS Code
 * would call them: hover, go-to-definition, references, rename, completion,
 * formatting and diagnostics.
 */

const path = require("path");
const fs = require("fs");
const {
  section, test, testAsync, eq, ok,
  vscode, registered, Doc, useWorkspace, OUT, FIXTURES,
} = require("./harness");

const WS = path.join(FIXTURES, "ws");
const COMPONENTS = path.join(WS, "src/components");
const UTILS = path.join(WS, "src/utils");
const PAGE = path.join(COMPONENTS, "Page.html");
const rel = (p) => (p ? p.replace(WS + path.sep, "").split(path.sep).join("/") : p);

const SCRIPTS = ["cart.js", "store.js", "theme.js"].map((f) => path.join(UTILS, f));
const HTML = ["Button.html", "Header.html"].map((f) => path.join(COMPONENTS, f));

// Register every provider once against the stub.
const context = { subscriptions: [] };
require(OUT + "/language/hover/hoverProvider").registerHoverProvider(context);
require(OUT + "/language/definitions/definitionProvider").registerDefinitionProvider(context);
require(OUT + "/language/references/referenceProvider").registerReferenceProvider(context);
require(OUT + "/language/rename/renameProvider").registerRenameProvider(context);
require(OUT + "/language/completion/completionProvider").registerCompletionProvider(context);
require(OUT + "/language/formatting/formattingProvider").registerFormattingProvider(context);
const { updateDiagnostics } = require(OUT + "/diagnostics/diagnostics");
const { caseFixEdits } = require(OUT + "/commands/fixes");
const { invalidateExportIndex } = require(OUT + "/modules/exports");

const hover = registered.hover[0];
const definition = registered.definition[0];
const references = registered.reference[0];
const rename = registered.rename[0];
const completion = registered.completion[0];
const formatting = registered.formatting[0];

/** Location of the definition at the first occurrence of `needle` (+delta). */
const defAt = (doc, needle, delta = 0) => definition.provideDefinition(doc, doc.posOf(needle, delta));
/** Line number (1-based) a definition landed on, for readable assertions. */
const defLine = (loc) => (loc ? loc.position.line + 1 : null);

module.exports = async function run() {
  useWorkspace(WS, { scripts: SCRIPTS, html: HTML });
  invalidateExportIndex();

  // ── hover ──────────────────────────────────────────────────────────────────
  section("providers › hover");

  test("a const shows its inferred type", () => {
    const doc = new Doc(`<script>\nconst title = "hi";\n</script>\n<p>{title}</p>`, PAGE);
    return ok(hover.provideHover(doc, doc.posOf("{title}", 2)).text.includes("(const) title: string"));
  });

  test("a function shows its signature", () => {
    const doc = new Doc(`<script>\nfunction go(a, b) {}\n</script>\n<p>{go}</p>`, PAGE);
    return ok(hover.provideHover(doc, doc.posOf("{go}", 1)).text.includes("(function) go(a, b): void"));
  });

  test("an object property is qualified by its object", () => {
    const doc = new Doc(`<script>\nconst r = { input: 1 };\n</script>\n<p>{r.input}</p>`, PAGE);
    return ok(hover.provideHover(doc, doc.posOf("{r.input}", 3)).text.includes("(property) r.input: number"));
  });

  test("a component names its module", () => {
    const doc = new Doc(`<script>\nimport Button from "./Button";\n</script>\n<Button />`, PAGE);
    const text = hover.provideHover(doc, doc.posOf("<Button />", 2)).text;
    return ok(text.includes("(component) Button")) && ok(text.includes("./Button"));
  });

  test("a <for> local is labelled as one", () => {
    const doc = new Doc(`<for each="todo of list"><p>{todo}</p></for>`, PAGE);
    return ok(hover.provideHover(doc, doc.posOf("{todo}", 2)).text.includes("(local var) todo"));
  });

  test("nothing hovers inside <script>", () => {
    const doc = new Doc(`<script>\nconst title = 1;\n</script>`, PAGE);
    return eq(hover.provideHover(doc, doc.posOf("title")), null);
  });

  // ── go to definition ───────────────────────────────────────────────────────
  section("providers › go to definition");

  test("a variable jumps to its declaration", () => {
    const doc = new Doc(`<script>\nconst title = 1;\n</script>\n<p>{title}</p>`, PAGE);
    const loc = defAt(doc, "{title}", 1);
    return eq(loc.uri.fsPath, PAGE) && eq(defLine(loc), 2);
  });

  test("a property jumps to its key", () => {
    const doc = new Doc(`<script>\nconst r = { input: 1 };\n</script>\n<p>{r.input}</p>`, PAGE);
    return eq(defLine(defAt(doc, "{r.input}", 3)), 2);
  });

  test("a <for> local jumps to its binding", () => {
    const doc = new Doc(`<for each="todo of list">\n<p>{todo}</p>\n</for>`, PAGE);
    return eq(defLine(defAt(doc, "{todo}", 2)), 1);
  });

  test("a component tag opens its file", () => {
    const doc = new Doc(`<script>\nimport Button from "./Button";\n</script>\n<Button />`, PAGE);
    return eq(rel(defAt(doc, "<Button />", 2).uri.fsPath), "src/components/Button.html");
  });

  test("a component with no import falls back to a sibling file", () => {
    const doc = new Doc(`<Header />`, PAGE);
    return eq(rel(defAt(doc, "<Header", 2).uri.fsPath), "src/components/Header.html");
  });

  test("an import path opens the module", () => {
    const doc = new Doc(`<script>\nimport { cart } from "../utils/cart";\n</script>`, PAGE);
    const loc = defAt(doc, "../utils/cart");
    return eq(rel(loc.uri.fsPath), "src/utils/cart.js") && eq(defLine(loc), 1);
  });

  test("an import path resolves a bare package specifier", () => {
    const doc = new Doc(`<script>\nimport { onMount } from "olum";\n</script>`, PAGE);
    return eq(rel(defAt(doc, `"olum"`, 1).uri.fsPath), "node_modules/olum/dist/olum.js");
  });

  test("an imported binding jumps to its export", () => {
    const doc = new Doc(`<script>\nimport { cartCount } from "../utils/cart";\n</script>`, PAGE);
    const loc = defAt(doc, "cartCount");
    const src = fs.readFileSync(loc.uri.fsPath, "utf8").split("\n")[loc.position.line];
    return ok(src.includes("export const cartCount"));
  });

  test("a use of an imported binding inside <script> jumps to its export", () => {
    const doc = new Doc(`<script>\nimport { cartCount } from "../utils/cart";\nconst n = cartCount();\n</script>`, PAGE);
    const loc = defAt(doc, "cartCount();");
    const src = fs.readFileSync(loc.uri.fsPath, "utf8").split("\n")[loc.position.line];
    return ok(src.includes("export const cartCount"));
  });

  test("an imported binding used in the template jumps to its export", () => {
    const doc = new Doc(`<script>\nimport { cartCount } from "../utils/cart";\n</script>\n<p>{cartCount}</p>`, PAGE);
    return eq(rel(defAt(doc, "{cartCount}", 1).uri.fsPath), "src/utils/cart.js");
  });

  test("a default import jumps to its export default", () => {
    const doc = new Doc(`<script>\nimport createStore from "../utils/store";\n</script>`, PAGE);
    const loc = defAt(doc, "createStore");
    const src = fs.readFileSync(loc.uri.fsPath, "utf8").split("\n")[loc.position.line];
    return ok(src.includes("export default"));
  });

  test("an unresolvable import yields no definition", () => {
    const doc = new Doc(`<script>\nimport x from "./nowhere";\n</script>`, PAGE);
    return eq(defAt(doc, "./nowhere"), null);
  });

  test("nothing navigates from plain script code", () => {
    const doc = new Doc(`<script>\nconst local = 1;\n</script>`, PAGE);
    return eq(defAt(doc, "local"), null);
  });

  // ── references and rename ──────────────────────────────────────────────────
  section("providers › references");

  const ctx = { includeDeclaration: true };

  test("every template use of a variable is found", () => {
    const doc = new Doc(`<script>\nconst t = 1;\n</script>\n<p>{t}</p><b>{t}</b>`, PAGE);
    return eq(references.provideReferences(doc, doc.posOf("{t}", 1), ctx).length, 3);
  });

  test("the declaration is excluded when not requested", () => {
    const doc = new Doc(`<script>\nconst t = 1;\n</script>\n<p>{t}</p>`, PAGE);
    return eq(references.provideReferences(doc, doc.posOf("{t}", 1), { includeDeclaration: false }).length, 1);
  });

  test("component tags and the import name are found together", () => {
    const doc = new Doc(`<script>\nimport Button from "./Button";\n</script>\n<Button /><Button />`, PAGE);
    return eq(references.provideReferences(doc, doc.posOf("<Button /><", 2), ctx).length, 3);
  });

  test("a <for> local's references stop at the loop body", () => {
    const doc = new Doc(`<for each="t of a"><p>{t}</p></for><p>{t}</p>`, PAGE);
    return eq(references.provideReferences(doc, doc.posOf("{t}", 1), ctx).length, 2);
  });

  section("providers › rename");

  test("renaming a variable rewrites uses and the declaration", () => {
    const doc = new Doc(`<script>\nconst t = 1;\n</script>\n<p>{t}</p>`, PAGE);
    return eq(rename.provideRenameEdits(doc, doc.posOf("{t}", 1), "total").size, 2);
  });

  test("renaming a component rewrites its tags and its import", () => {
    const doc = new Doc(`<script>\nimport Button from "./Button";\n</script>\n<Button />`, PAGE);
    const edit = rename.provideRenameEdits(doc, doc.posOf("<Button />", 2), "Btn");
    return eq(edit.size, 2) && ok(edit.edits.every((e) => e.newText === "Btn"));
  });

  test("prepareRename marks the symbol's own range", () => {
    const doc = new Doc(`<script>\nconst t = 1;\n</script>\n<p>{t}</p>`, PAGE);
    const range = rename.prepareRename(doc, doc.posOf("{t}", 1));
    return eq(doc.getText(range), "t");
  });

  test("prepareRename refuses a non-symbol", () => {
    const doc = new Doc(`<p>plain</p>`, PAGE);
    try { rename.prepareRename(doc, doc.posOf("plain")); return false; } catch { return true; }
  });

  // ── completion ─────────────────────────────────────────────────────────────
  section("providers › completion");

  const items = async (doc, needle, delta) => {
    const r = await completion.provideCompletionItems(doc, doc.posOf(needle, delta));
    return r ? r.items ?? r : [];
  };
  const labels = (list) => list.map((i) => String(i.label));

  await testAsync("after `<`, imported components are offered", async () => {
    const doc = new Doc(`<script>\nimport Button from "./Button";\n</script>\n<`, PAGE);
    return ok(labels(await items(doc, "\n<", 2)).includes("Button"));
  });

  await testAsync("after `<`, workspace components are offered with an import edit", async () => {
    const doc = new Doc(`<script>\n</script>\n<`, PAGE);
    const header = (await items(doc, "\n<", 2)).find((i) => i.label === "Header");
    return ok(header) && ok(header.additionalTextEdits[0].newText.includes('import Header from "./Header"'));
  });

  await testAsync("inside `{}`, in-scope variables are offered", async () => {
    const doc = new Doc(`<script>\nconst title = 1;\nfunction go(a) { return a; }\n</script>\n<p>{}</p>`, PAGE);
    const l = labels(await items(doc, "{}", 1));
    return ok(l.includes("title")) && ok(l.includes("go")) && ok(l.includes("props"));
  });

  await testAsync("inside `{}`, <for> locals are offered", async () => {
    const doc = new Doc(`<for each="todo of list"><p>{}</p></for>`, PAGE);
    return ok(labels(await items(doc, "{}", 1)).includes("todo"));
  });

  await testAsync("inside `{}`, a component import is not offered as a value", async () => {
    const doc = new Doc(`<script>\nimport Button from "./Button";\n</script>\n<p>{}</p>`, PAGE);
    return eq(labels(await items(doc, "{}", 1)).includes("Button"), false);
  });

  await testAsync("inside `{}`, a PascalCase *named* import is offered as a value", async () => {
    const doc = new Doc(`<script>\nimport { ArrowRight } from "olum-icons/lucide";\n</script>\n<p>{}</p>`, PAGE);
    return ok(labels(await items(doc, "{}", 1)).includes("ArrowRight"));
  });

  await testAsync("in <script>, a workspace export auto-imports", async () => {
    const doc = new Doc(`<script>\ncartCou\n</script>`, PAGE);
    const item = (await items(doc, "cartCou", 7)).find((i) => i.label === "cartCount");
    return ok(item) && eq(item.additionalTextEdits[0].newText, '\n  import { cartCount } from "../utils/cart";');
  });

  await testAsync("in <script>, a package export auto-imports", async () => {
    const doc = new Doc(`<script>\nonMou\n</script>`, PAGE);
    const item = (await items(doc, "onMou", 5)).find((i) => i.label === "onMount");
    return ok(item) && eq(item.additionalTextEdits[0].newText, '\n  import { onMount } from "olum";');
  });

  await testAsync("in <script>, a default export auto-imports without braces", async () => {
    const doc = new Doc(`<script>\ncreateSt\n</script>`, PAGE);
    const item = (await items(doc, "createSt", 8)).find((i) => i.label === "createStore");
    return ok(item) && eq(item.additionalTextEdits[0].newText, '\n  import createStore from "../utils/store";');
  });

  await testAsync("a new name merges into an existing import from the same module", async () => {
    const doc = new Doc(`<script>\nimport { onMount } from "olum";\nprop\n</script>`, PAGE);
    const item = (await items(doc, "\nprop", 5)).find((i) => i.label === "props");
    return ok(item) && eq(item.additionalTextEdits[0].newText, ", props");
  });

  await testAsync("a name already in scope is not offered", async () => {
    const doc = new Doc(`<script>\nimport { cartCount } from "../utils/cart";\ncartCou\n</script>`, PAGE);
    return eq(labels(await items(doc, "\ncartCou", 8)).includes("cartCount"), false);
  });

  await testAsync("implicit props is still importable inside <script>", async () => {
    const doc = new Doc(`<script>\nprop\n</script>`, PAGE);
    return ok(labels(await items(doc, "prop", 4)).includes("props"));
  });

  await testAsync("no suggestions before a character is typed", async () => {
    const doc = new Doc(`<script>\n\n</script>`, PAGE);
    return eq((await items(doc, "<script>\n", 9)).length, 0);
  });

  await testAsync("no suggestions inside an import statement", async () => {
    const doc = new Doc(`<script>\nimport { on } from "olum";\n</script>`, PAGE);
    return eq(await items(doc, "{ on", 4), []);
  });

  await testAsync("no suggestions inside <style>", async () => {
    const doc = new Doc(`<style>\n.a { color: red; }\n</style>`, PAGE);
    return eq(await items(doc, "color", 5), []);
  });

  await testAsync("the list is marked incomplete so VS Code re-queries", async () => {
    const doc = new Doc(`<script>\ncartCou\n</script>`, PAGE);
    const r = await completion.provideCompletionItems(doc, doc.posOf("cartCou", 7));
    return eq(r.isIncomplete, true);
  });

  await testAsync("the removed runtime snippets are gone", async () => {
    const doc = new Doc(`<script>\nonMou\n</script>`, PAGE);
    return eq((await items(doc, "onMou", 5)).some((i) => i.insertText), false);
  });

  // ── diagnostics ────────────────────────────────────────────────────────────
  section("providers › diagnostics");

  const diagnose = (text) => {
    const doc = new Doc(text, PAGE);
    const store = new Map();
    updateDiagnostics(doc, { set: (uri, d) => store.set(uri.toString(), d), delete: () => {} });
    return store.get(doc.uri.toString()) || [];
  };

  test("an unimported component warns", () => {
    const d = diagnose(`<Missing />`);
    return eq(d.length, 1) && ok(d[0].message.includes("'Missing' is used but not imported"));
  });

  test("an imported component does not warn", () => {
    return eq(diagnose(`<script>\nimport Button from "./Button";\n</script>\n<Button />`).length, 0);
  });

  test("a duplicate prop warns", () => {
    const d = diagnose(`<script>\nimport Button from "./Button";\n</script>\n<Button a="1" a="2" />`);
    return eq(d.length, 1) && ok(d[0].message.includes("Duplicate prop 'a'"));
  });

  test("flow tags never warn about imports", () => {
    return eq(diagnose(`<if when="a"><p>x</p></if>`).length, 0);
  });

  test("a closing tag does not warn twice", () => {
    return eq(diagnose(`<Missing></Missing>`).length, 1);
  });

  // ── formatting ─────────────────────────────────────────────────────────────
  section("providers › formatting");

  const format = (text) => {
    const doc = new Doc(text, PAGE);
    const edits = formatting.provideDocumentFormattingEdits(doc, { insertSpaces: true, tabSize: 2 });
    return edits.length ? edits[0].newText : text;
  };

  test("indentation is normalised", () => {
    return ok(format(`<div>\n<p>hi</p>\n</div>`).includes("\n  <p>hi</p>"));
  });

  test("component tag case is preserved", () => {
    return ok(format(`<div>\n<Button />\n</div>`).includes("<Button />"));
  });

  test("flow tags survive formatting", () => {
    return ok(format(`<div>\n<if when="a">x</if>\n</div>`).includes(`<if when="a">`));
  });

  test("an expression attribute is left intact", () => {
    return ok(format(`<div>\n<for each="x of list">y</for>\n</div>`).includes(`each="x of list"`));
  });

  test("already-formatted input produces no edit", () => {
    const doc = new Doc(`<div>\n  <p>hi</p>\n</div>`, PAGE);
    const once = formatting.provideDocumentFormattingEdits(doc, { insertSpaces: true, tabSize: 2 });
    const settled = new Doc(once.length ? once[0].newText : doc.getText(), PAGE);
    return eq(formatting.provideDocumentFormattingEdits(settled, { insertSpaces: true, tabSize: 2 }).length, 0);
  });

  // ── component case auto-repair ─────────────────────────────────────────────
  section("providers › component case repair");

  const fixes = (text) => {
    const doc = new Doc(text, PAGE);
    return caseFixEdits(doc).map((e) => [doc.getText(e.range), e.newText]);
  };

  test("a lowercased component tag is corrected", () => {
    return eq(fixes(`<script>\nimport Card from "./Card";\n</script>\n<card></card>`),
      [["card", "Card"], ["card", "Card"]]);
  });

  test("a real HTML element is never rewritten", () => {
    return eq(fixes(`<script>\nimport Button from "./Button";\n</script>\n<button>x</button>`), []);
  });

  test("other HTML-named components are left alone too", () => {
    return eq(fixes(`<script>\nimport Header from "./Header";\nimport Form from "./Form";\n</script>\n<header></header><form></form>`), []);
  });

  test("correctly cased tags produce no edits, so the fix loop terminates", () => {
    return eq(fixes(`<script>\nimport Card from "./Card";\n</script>\n<Card />`), []);
  });

  test("a component named inside <script> is not rewritten", () => {
    return eq(fixes(`<script>\nimport Card from "./Card";\nconst s = "<card />";\n</script>`), []);
  });
};
