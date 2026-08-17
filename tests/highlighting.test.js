/**
 * Highlighting: the expression tokenizer, and the decoration buckets the
 * highlighter assigns to a parsed document.
 */

const { section, test, eq, ok, vscode, Doc, makeEditor, OUT } = require("./harness");
const { tokenize } = require(OUT + "/highlighting/exprTokens");
const { highlight } = require(OUT + "/highlighting/highlighter");
const { createDecorations } = require(OUT + "/highlighting/decorations");
const { getColors } = require(OUT + "/utils/colors");
const { getModel } = require(OUT + "/parser/documentModel");

const kinds = (src) => tokenize(src, 0).map((t) => t.kind);
const slice = (src) => tokenize(src, 0).map((t) => [t.kind, src.slice(t.start, t.end)]);

/**
 * Highlight `text` and return a map of bucket → the substrings it coloured, so
 * assertions read as "this bucket got these words".
 *
 * Identical ranges are collapsed. A token can legitimately be pushed twice — a
 * `<for>` binding is painted once by the expression walk and once by the scope
 * walk — and the editor renders that as a single decoration either way.
 */
function paint(text) {
  const doc = new Doc(text);
  const editor = makeEditor(doc);
  const decorations = createDecorations(getColors());
  const byType = new Map();
  editor.setDecorations = (type, ranges) => byType.set(type, ranges);

  highlight(editor, getModel(doc), decorations);

  const result = {};
  for (const [bucket, type] of Object.entries(decorations)) {
    const seen = new Set();
    result[bucket] = (byType.get(type) || [])
      .filter((r) => {
        const key = `${doc.offsetAt(r.start)}:${doc.offsetAt(r.end)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((r) => doc.getText(r));
  }
  return result;
}

module.exports = function run() {
  // ── tokenizer ──────────────────────────────────────────────────────────────
  section("highlighting › expression tokenizer");

  test("numbers, booleans and nullish literals", () =>
    eq(kinds("1 true false null undefined"), ["number", "bool", "bool", "nullish", "nullish"]));

  test("identifiers and member access", () =>
    eq(slice("props.todos"), [["ident", "props"], ["punct", "."], ["ident", "todos"]]));

  test("strings keep their quotes as separate tokens", () =>
    eq(slice("'hi'"), [["quote", "'"], ["string", "hi"], ["quote", "'"]]));

  test("declaration keywords", () =>
    eq(kinds("const let function class new this"),
      ["keywordDecl", "keywordDecl", "keywordDecl", "keywordDecl", "keywordDecl", "keywordDecl"]));

  test("flow keywords", () => eq(kinds("if else return typeof of in"),
    ["keywordFlow", "keywordFlow", "keywordFlow", "keywordFlow", "keywordFlow", "keywordFlow"]));

  test("brackets are inner braces", () =>
    eq(kinds("{}[]()"), ["innerBrace", "innerBrace", "innerBrace", "innerBrace", "innerBrace", "innerBrace"]));

  test("a multi-character operator is one token", () =>
    eq(slice("a === b"), [["ident", "a"], ["punct", "==="], ["ident", "b"]]));

  test("an arrow is one token", () =>
    eq(slice("() => x"), [["innerBrace", "("], ["innerBrace", ")"], ["punct", "=>"], ["ident", "x"]]));

  test("negative numbers", () => eq(slice("-5"), [["number", "-5"]]));

  test("offsets honour the base", () => {
    const [t] = tokenize("abc", 50);
    return eq([t.start, t.end], [50, 53]);
  });

  test("whitespace produces no tokens", () => eq(tokenize("   \n\t ", 0).length, 0));

  // ── highlighter buckets ────────────────────────────────────────────────────
  section("highlighting › decoration buckets");

  test("component tag names are coloured as components", () => {
    const b = paint(`<Header /><div/>`);
    return eq(b.comp, ["Header"]);
  });

  test("closing component tags are coloured too", () => {
    const b = paint(`<Card>x</Card>`);
    return eq(b.comp, ["Card", "Card"]);
  });

  test("flow tags colour their brackets and keyword", () => {
    const b = paint(`<if when="a">x</if>`);
    return eq(b.flow, ["<", "if", ">", "<", "if", ">"]);
  });

  test("attribute names and the equals sign are coloured", () => {
    const b = paint(`<Card title="x" />`);
    return eq(b.propName, ["title"]) && eq(b.propEq, ["="]);
  });

  test("string quotes and content are separate buckets", () => {
    const b = paint(`<Card title="hi" />`);
    return eq(b.strQuote, ['"', '"']) && eq(b.str, ["hi"]);
  });

  test("an interpolation's braces are coloured as braces", () => {
    const b = paint(`<p>{title}</p>`);
    return eq(b.brace, ["{", "}"]) && eq(b.varVal, ["title"]);
  });

  test("literal text around an interpolation stays a string", () => {
    const b = paint(`<Card class="a {size} b" />`);
    return eq(b.str, ["a ", " b"]) && eq(b.varVal, ["size"]);
  });

  test("numbers and booleans inside expressions get their own colour", () => {
    const b = paint(`<if when="a === 1 && b === true"></if>`);
    return eq(b.num, ["1"]) && eq(b.kw, ["true"]);
  });

  test("<for> locals are coloured distinctly from other variables", () => {
    const b = paint(`<for each="todo of list"><p>{todo}</p></for>`);
    return eq(b.forLocal, ["todo", "todo"]) && eq(b.varVal, ["list"]);
  });

  test("<transition> logic attributes are coloured as code, not string", () => {
    const b = paint(`<transition in="fly({ y: 200 })"><p/></transition>`);
    return ok(b.varVal.includes("fly")) && ok(b.num.includes("200")) && eq(b.str, []);
  });

  test("a plain on* handler defers to the editor's own JS grammar", () => {
    const b = paint(`<Card onclick="save()" />`);
    return eq(b.varVal, []);
  });

  test("an anonymous handler is coloured by us", () => {
    const b = paint(`<Card onclick="() => save()" />`);
    return ok(b.varVal.includes("save"));
  });

  test("nothing inside <script> is coloured", () => {
    const b = paint(`<script>const Card = 1;\nconst x = {a: 1};</script>`);
    return eq(b.comp, []) && eq(b.varVal, []) && eq(b.brace, []);
  });

  test("nothing inside <style> is coloured", () => {
    const b = paint(`<style>.a { color: red; }</style>`);
    return eq(b.brace, []) && eq(b.propName, []);
  });
};
