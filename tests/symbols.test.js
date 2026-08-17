/**
 * `<script>` scope: import parsing, declaration extraction, object members,
 * type inference, and the component-import rules layered on top.
 */

const { section, test, eq, ok, OUT } = require("./harness");
const { parse } = require(OUT + "/parser/documentModel");
const { buildSymbolTable } = require(OUT + "/scanner/scriptScope");
const { inferType, buildLabel } = require(OUT + "/scanner/symbols");
const { componentImports, allImports, importSpecMap } = require(OUT + "/components/imports");

const scriptOf = (body) => `<script>\n${body}\n</script>\n<div></div>`;
const symbolsOf = (body) => buildSymbolTable(parse(scriptOf(body)));
const importsOf = (body) => [...symbolsOf(body).byName.values()].filter((d) => d.kind === "import");

module.exports = function run() {
  // ── imports ────────────────────────────────────────────────────────────────
  section("symbols › import forms");

  test("default import", () => {
    const [d] = importsOf(`import Header from "./Header";`);
    return eq([d.name, d.importKind, d.importSpec], ["Header", "default", "./Header"]);
  });

  test("named imports", () => {
    const list = importsOf(`import { cart, cartTotal } from "../utils/cart";`);
    return eq(list.map((d) => [d.name, d.importKind]), [["cart", "named"], ["cartTotal", "named"]]);
  });

  test("aliased named import records both names", () => {
    const [d] = importsOf(`import { ArrowRight as Next } from "olum-icons/lucide";`);
    return eq([d.name, d.exportName], ["Next", "ArrowRight"]);
  });

  test("namespace import", () => {
    const [d] = importsOf(`import * as helpers from "./helpers";`);
    return eq([d.name, d.importKind], ["helpers", "namespace"]);
  });

  test("mixed default + named import", () => {
    const list = importsOf(`import Store, { watch } from "olum-store";`);
    return eq(list.map((d) => [d.name, d.importKind]), [["Store", "default"], ["watch", "named"]]);
  });

  test("multi-line named imports", () => {
    const list = importsOf(`import {\n  a,\n  b,\n} from "./m";`);
    return eq(list.map((d) => d.name), ["a", "b"]);
  });

  test("a side-effect import declares nothing", () => {
    return eq(importsOf(`import "./styles.css";`).length, 0);
  });

  test("a side-effect import does not swallow the next statement", () => {
    const list = importsOf(`import "./styles.css";\nimport { onMount } from "olum";`);
    return eq(list.map((d) => d.name), ["onMount"]);
  });

  test("single-quoted specifiers work", () => {
    const [d] = importsOf(`import x from './x';`);
    return eq(d.importSpec, "./x");
  });

  test("binding offsets point at the binding", () => {
    const src = scriptOf(`import { cart as basket } from "./c";`);
    const [d] = [...buildSymbolTable(parse(src)).byName.values()].filter((x) => x.kind === "import");
    return eq(src.slice(d.nameStart, d.nameEnd), "basket");
  });

  test("specifier offsets point at the path, excluding quotes", () => {
    const src = scriptOf(`import Header from "./Header";`);
    const [d] = [...buildSymbolTable(parse(src)).byName.values()].filter((x) => x.kind === "import");
    return eq(src.slice(d.specStart, d.specEnd), "./Header");
  });

  // ── declarations ───────────────────────────────────────────────────────────
  section("symbols › declarations");

  test("function declarations", () => {
    const d = symbolsOf(`function greet(a, b) {}`).lookup("greet");
    return eq([d.kind, d.params], ["function", "a, b"]);
  });

  test("arrow consts are functions", () => {
    const d = symbolsOf(`const go = (x) => x;`).lookup("go");
    return eq([d.kind, d.params], ["function", "x"]);
  });

  test("async arrow consts are functions", () => {
    return eq(symbolsOf(`const load = async () => {};`).lookup("load").kind, "function");
  });

  test("class declarations", () => {
    return eq(symbolsOf(`class Thing {}`).lookup("Thing").kind, "class");
  });

  test("let and var keep their kind", () => {
    const s = symbolsOf(`let a = 1;\nvar b = 2;`);
    return eq([s.lookup("a").kind, s.lookup("b").kind], ["let", "var"]);
  });

  test("this.x fields become properties", () => {
    return eq(symbolsOf(`this.count = 3;`).lookup("count").kind, "property");
  });

  test("implicit props is always available", () => {
    const d = symbolsOf(`const a = 1;`).lookup("props");
    return eq(d.synthetic, true);
  });

  test("a leading comment becomes documentation", () => {
    return eq(symbolsOf(`// counts things\nconst total = 1;`).lookup("total").doc, "counts things");
  });

  // ── object members ─────────────────────────────────────────────────────────
  section("symbols › object members");

  test("top-level properties are recorded", () => {
    const s = symbolsOf(`const state = { name: "a", count: 1 };`);
    return eq(s.lookupMember("state", "name").kind, "property")
      && eq(s.lookupMember("state", "count").type, "number");
  });

  test("methods are recorded as methods", () => {
    const s = symbolsOf(`const api = { load() {} };`);
    return eq(s.lookupMember("api", "load").kind, "method");
  });

  test("nested keys are not top-level members", () => {
    const s = symbolsOf(`const state = { outer: { inner: 1 } };`);
    return eq(s.lookupMember("state", "inner"), undefined)
      && ok(s.lookupMember("state", "outer"));
  });

  test("a quoted value containing a brace does not confuse the walk", () => {
    const s = symbolsOf(`const state = { a: "}{", b: 2 };`);
    return eq(s.lookupMember("state", "b").type, "number");
  });

  // ── type inference and labels ──────────────────────────────────────────────
  section("symbols › inferred types");

  test("literal types", () => eq(
    ["'x'", "12", "true", "null", "undefined", "[1]", "{}", "() => 1", "new Date()"].map(inferType),
    ["string", "number", "boolean", "null", "undefined", "any[]", "object", "Function", "Date"],
  ));

  test("an unknown shape falls back to any", () => eq(inferType("someCall()"), "any"));

  test("labels read like TypeScript signatures", () => {
    return eq(buildLabel({ kind: "function", name: "go", params: "a" }), "(function) go(a): void")
      && eq(buildLabel({ kind: "const", name: "n", type: "number" }), "(const) n: number")
      && eq(buildLabel({ kind: "class", name: "T" }), "(class) T");
  });

  // ── component import rules ─────────────────────────────────────────────────
  section("symbols › component imports");

  test("a PascalCase default import is a component", () => {
    return eq(componentImports(symbolsOf(`import Header from "./Header";`)).map((c) => c.name), ["Header"]);
  });

  test("a PascalCase *named* import is a value, not a component", () => {
    const s = symbolsOf(`import { ArrowRight } from "olum-icons/lucide";`);
    return eq(componentImports(s).length, 0);
  });

  test("a lowercase default import is not a component", () => {
    return eq(componentImports(symbolsOf(`import cart from "./cart";`)).length, 0);
  });

  test("allImports returns every binding regardless of shape", () => {
    const s = symbolsOf(`import Header from "./Header";\nimport { cart } from "./cart";`);
    return eq(allImports(s).map((d) => d.name), ["Header", "cart"]);
  });

  test("importSpecMap maps component name to specifier", () => {
    const s = symbolsOf(`import Header from "./ui/Header";`);
    return eq(importSpecMap(s).get("Header"), "./ui/Header");
  });
};
