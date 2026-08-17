/**
 * Module resolution and the auto-import symbol index, exercised against the
 * fixture workspace in `tests/fixtures/ws` so results never depend on whatever
 * happens to be installed on the machine.
 */

const path = require("path");
const { section, test, testAsync, eq, ok, useWorkspace, OUT, FIXTURES } = require("./harness");
const { resolveModule, resolveExports, splitBareSpec, isRelative } = require(OUT + "/modules/resolver");
const {
  parseExports, defaultExportName, exportOffset, relativeSpecifier,
  importableSymbols, invalidateExportIndex,
} = require(OUT + "/modules/exports");

const WS = path.join(FIXTURES, "ws");
const SRC = path.join(WS, "src");
const UTILS = path.join(SRC, "utils");
const COMPONENTS = path.join(SRC, "components");
const rel = (p) => (p ? p.replace(WS + path.sep, "").split(path.sep).join("/") : p);

const SCRIPTS = [
  "cart.js", "store.js", "theme.js", "anon.js", "barrel.js",
  "loop-a.js", "loop-b.js", "aliased.js",
].map((f) => path.join(UTILS, f));
const HTML = ["Button.html", "Header.html"].map((f) => path.join(COMPONENTS, f));

module.exports = async function run() {
  useWorkspace(WS, { scripts: SCRIPTS, html: HTML });
  invalidateExportIndex();

  // ── relative specifiers ────────────────────────────────────────────────────
  section("modules › relative resolution");

  test("an extensionless path finds the .js file", () =>
    eq(rel(resolveModule("./cart", UTILS)), "src/utils/cart.js"));

  test("an explicit extension resolves as written", () =>
    eq(rel(resolveModule("./cart.js", UTILS)), "src/utils/cart.js"));

  test("a parent-relative path resolves", () =>
    eq(rel(resolveModule("../utils/cart", COMPONENTS)), "src/utils/cart.js"));

  test("html preference finds the component file", () =>
    eq(rel(resolveModule("./Button", COMPONENTS, "html")), "src/components/Button.html"));

  test("script preference still finds an .html file when nothing else matches", () =>
    eq(rel(resolveModule("./Button", COMPONENTS, "script")), "src/components/Button.html"));

  test("a missing module resolves to null", () =>
    eq(resolveModule("./nope", UTILS), null));

  test("a path escaping the workspace is rejected", () =>
    eq(resolveModule("../../../../../etc/passwd", UTILS), null));

  test("isRelative classifies specifiers", () =>
    eq(["./a", "../a", "/a", "olum", "@scope/p"].map(isRelative), [true, true, true, false, false]));

  // ── bare specifiers ────────────────────────────────────────────────────────
  section("modules › node_modules resolution");

  test("a package resolves through main", () =>
    eq(rel(resolveModule("olum", SRC)), "node_modules/olum/dist/olum.js"));

  test("a package resolves from a nested directory", () =>
    eq(rel(resolveModule("olum", UTILS)), "node_modules/olum/dist/olum.js"));

  test("an exports subpath resolves", () =>
    eq(rel(resolveModule("olum-icons/lucide", SRC)), "node_modules/olum-icons/dist/lucide/index.js"));

  test("the exports root resolves", () =>
    eq(rel(resolveModule("olum-icons", SRC)), "node_modules/olum-icons/dist/index.js"));

  test("a wildcard exports pattern resolves", () =>
    eq(rel(resolveModule("olum-icons/OlumLogo.js", SRC)), "node_modules/olum-icons/dist/OlumLogo.js"));

  test("a condition object prefers the import condition", () =>
    eq(rel(resolveModule("cond-pkg", SRC)), "node_modules/cond-pkg/esm/i.js"));

  test("a package with no main falls back to index.js", () =>
    eq(rel(resolveModule("dir-pkg", SRC)), "node_modules/dir-pkg/index.js"));

  test("an uninstalled package resolves to null", () =>
    eq(resolveModule("not-installed", SRC), null));

  test("splitBareSpec separates package from subpath", () => eq(
    [splitBareSpec("olum"), splitBareSpec("olum-icons/lucide"), splitBareSpec("@scope/p/sub")],
    [{ pkgName: "olum", subpath: "." },
     { pkgName: "olum-icons", subpath: "./lucide" },
     { pkgName: "@scope/p", subpath: "./sub" }],
  ));

  test("resolveExports handles the string form", () =>
    eq(resolveExports("./dist/i.js", "."), "./dist/i.js"));

  test("resolveExports rejects a subpath the map does not declare", () =>
    eq(resolveExports({ ".": "./i.js" }, "./missing"), null));

  // ── export parsing ─────────────────────────────────────────────────────────
  section("modules › export parsing");

  test("export const / function / class", () => eq(
    parseExports("export const a=1;\nexport function b(){}\nexport class C {}").names.sort(),
    ["C", "a", "b"],
  ));

  test("export { a, b as c }", () =>
    eq(parseExports("export { a, b as c };").names.sort(), ["a", "c"]));

  test("re-export from another module", () =>
    eq(parseExports('export { X } from "./x.js";').names, ["X"]));

  test("export * as ns", () =>
    eq(parseExports('export * as ns from "./x.js";').names, ["ns"]));

  test("export default is detected", () =>
    eq(parseExports("export default 1;").hasDefault, true));

  test("a module with no default reports none", () =>
    eq(parseExports("export const a = 1;").hasDefault, false));

  test("named default export via a declaration", () =>
    eq(defaultExportName("export default function createStore(){}"), "createStore"));

  test("named default export via a class", () =>
    eq(defaultExportName("export default class Store {}"), "Store"));

  test("named default export via a binding", () =>
    eq(defaultExportName("const theme = {};\nexport default theme;"), "theme"));

  test("an anonymous default export has no name", () =>
    eq(defaultExportName("export default { a: 1 };"), undefined));

  // ── export offsets ─────────────────────────────────────────────────────────
  section("modules › export offsets");

  test("offset of a named export lands on the name", () => {
    const file = path.join(UTILS, "cart.js");
    const src = require("fs").readFileSync(file, "utf8");
    return eq(src.slice(exportOffset(file, "cartCount", false), exportOffset(file, "cartCount", false) + 9), "cartCount");
  });

  test("offset of a re-exported name lands on it", () => {
    const file = path.join(WS, "node_modules/olum-icons/dist/lucide/index.js");
    const src = require("fs").readFileSync(file, "utf8");
    const at = exportOffset(file, "ArrowRight", false);
    return eq(src.slice(at, at + 10), "ArrowRight");
  });

  test("offset of a default export lands on the statement", () => {
    const file = path.join(UTILS, "store.js");
    const src = require("fs").readFileSync(file, "utf8");
    return ok(src.slice(exportOffset(file, "createStore", true)).startsWith("export default"));
  });

  test("an unknown name reports -1", () =>
    eq(exportOffset(path.join(UTILS, "cart.js"), "nothingHere", false), -1));

  // ── specifier formatting ───────────────────────────────────────────────────
  section("modules › specifier formatting");

  test("a sibling file", () =>
    eq(relativeSpecifier(UTILS, path.join(UTILS, "cart.js")), "./cart"));

  test("a file one directory up", () =>
    eq(relativeSpecifier(COMPONENTS, path.join(UTILS, "cart.js")), "../utils/cart"));

  test("an index file collapses to its directory", () =>
    eq(relativeSpecifier(SRC, path.join(UTILS, "index.js")), "./utils"));

  // ── the index ──────────────────────────────────────────────────────────────
  section("modules › importable symbol index");

  const from = path.join(COMPONENTS, "Page.html");
  const find = (all, name) => all.filter((e) => e.name === name);

  await testAsync("named workspace exports are indexed", async () => {
    const all = await importableSymbols(from);
    // Offered once per module that exports it — `barrel.js` re-exports it too,
    // and importing from either file is correct.
    return ok(find(all, "cartCount").some((e) => rel(e.file) === "src/utils/cart.js"));
  });

  await testAsync("a symbol re-exported by two modules is offered from both", async () => {
    const all = await importableSymbols(from);
    return eq(find(all, "cartCount").map((e) => rel(e.file)).sort(),
      ["src/utils/barrel.js", "src/utils/cart.js"]);
  });

  await testAsync("package exports are indexed under their specifier", async () => {
    const all = await importableSymbols(from);
    return eq(find(all, "ArrowRight").map((e) => e.spec), ["olum-icons/lucide"]);
  });

  await testAsync("a default export is offered under its declared name", async () => {
    const all = await importableSymbols(from);
    return ok(find(all, "createStore").some((e) => e.isDefault && rel(e.file) === "src/utils/store.js"));
  });

  await testAsync("a default export is also offered under its file name", async () => {
    const all = await importableSymbols(from);
    return ok(find(all, "store").some((e) => e.isDefault && rel(e.file) === "src/utils/store.js"));
  });

  await testAsync("an anonymous default falls back to the file name", async () => {
    const all = await importableSymbols(from);
    return ok(find(all, "anon").some((e) => e.isDefault));
  });

  await testAsync("a package default export is indexed", async () => {
    const all = await importableSymbols(from);
    return ok(find(all, "Store").some((e) => e.spec === "olum-store" && e.isDefault));
  });

  await testAsync("an anonymous package default uses the specifier's last segment", async () => {
    const all = await importableSymbols(from);
    return ok(find(all, "olum").some((e) => e.spec === "olum" && e.isDefault));
  });

  await testAsync("export * barrels expose the re-exported names", async () => {
    const all = await importableSymbols(from);
    return ok(find(all, "cartCount").some((e) => rel(e.file) === "src/utils/barrel.js"));
  });

  await testAsync("mutually recursive barrels terminate", async () => {
    const all = await importableSymbols(from);
    return ok(find(all, "A").some((e) => rel(e.file) === "src/utils/loop-b.js"))
      && ok(find(all, "B").some((e) => rel(e.file) === "src/utils/loop-a.js"));
  });

  await testAsync("an alias is indexed under its exported name", async () => {
    const all = await importableSymbols(from);
    return eq(find(all, "publicName").length, 1) && eq(find(all, "internal").length, 0);
  });

  await testAsync("the importing file never offers itself", async () => {
    const all = await importableSymbols(path.join(UTILS, "cart.js"));
    return eq(all.filter((e) => e.file === path.join(UTILS, "cart.js")).length, 0);
  });

  await testAsync("workspace symbols rank before package symbols", async () => {
    const all = await importableSymbols(from);
    const firstPkg = all.findIndex((e) => e.spec);
    const lastLocal = all.map((e) => !e.spec).lastIndexOf(true);
    return ok(firstPkg > lastLocal, "package entries should follow local ones");
  });
};
