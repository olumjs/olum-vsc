/**
 * Parser: the structural scan, expression extraction and `<for>` scope
 * resolution that every other feature reads from.
 */

const { section, test, eq, ok, OUT } = require("./harness");
const { parse, isInRawRegion, anyForScopeDeclares, forScopeAt, expressionAt } = require(OUT + "/parser/documentModel");
const { FLOW_TAG_NAMES } = require(OUT + "/parser/types");
const { parseExpression, parseForEach } = require(OUT + "/parser/expression");

const names = (list) => list.map((x) => x.name);
const attrOf = (tag, name) => tag.attrs.find((a) => a.name === name);

module.exports = function run() {
  // ── component tags ─────────────────────────────────────────────────────────
  section("parser › component tags");

  test("PascalCase tags are recognised, lowercase ones are not", () => {
    const m = parse(`<Header /><div></div><Footer></Footer>`);
    return eq(names(m.components), ["Header", "Footer", "Footer"]);
  });

  test("closing tags are flagged", () => {
    const m = parse(`<Card>x</Card>`);
    return eq(m.components.map((c) => c.isClosing), [false, true]);
  });

  test("self-closing is detected", () => {
    const m = parse(`<Card />`);
    return eq(m.components[0].selfClosing, true);
  });

  test("name offsets point at the name, not the angle bracket", () => {
    const text = `<div><Card /></div>`;
    const m = parse(text);
    return eq(text.slice(m.components[0].nameStart, m.components[0].nameEnd), "Card");
  });

  test("a tag spanning several lines is one tag", () => {
    const m = parse(`<Card\n  a="1"\n  b="2"\n/>`);
    return eq(m.components.length, 1) && eq(m.components[0].attrs.length, 2);
  });

  test("an unterminated tag does not hang or spill", () => {
    const m = parse(`<Card a="1"`);
    return eq(m.components.length, 1);
  });

  // ── flow tags ──────────────────────────────────────────────────────────────
  section("parser › flow tags");

  test("every declared flow tag is recognised", () => {
    const src = FLOW_TAG_NAMES.map((n) => `<${n}></${n}>`).join("");
    const m = parse(src);
    return eq(m.flows.length, FLOW_TAG_NAMES.length * 2);
  });

  test("<log> and <transition> are flow tags", () => {
    const m = parse(`<log>{a}</log><transition in="fade"><p/></transition>`);
    const kinds = [...new Set(m.flows.map((f) => f.kind))].sort();
    return eq(kinds, ["log", "transition"]);
  });

  test("a lookalike name is not a flow tag", () => {
    const m = parse(`<iffy></iffy><logger></logger>`);
    return eq(m.flows.length, 0);
  });

  test("flow keyword offsets are exact", () => {
    const text = `<else-if when="a">x</else-if>`;
    const m = parse(text);
    const open = m.flows[0];
    return eq(text.slice(open.keywordStart, open.keywordEnd), "else-if");
  });

  // ── attributes ─────────────────────────────────────────────────────────────
  section("parser › attributes");

  test("valueless attributes are boolean", () => {
    const m = parse(`<Card disabled />`);
    return eq(m.components[0].attrs[0].kind, "boolean");
  });

  test("ordinary attributes are literal strings", () => {
    const m = parse(`<Card title="hello" />`);
    return eq(m.components[0].attrs[0].kind, "string");
  });

  test("when/each/key/html are expression attributes", () => {
    const m = parse(`<if when="a"></if><for each="x of y" key="x.id"></for><div html="raw"></div>`);
    const whenAttr = attrOf(m.flows[0], "when");
    const eachAttr = attrOf(m.flows[2], "each");
    const keyAttr = attrOf(m.flows[2], "key");
    return eq([whenAttr.kind, eachAttr.kind, keyAttr.kind], ["expr", "expr", "expr"]);
  });

  test("on* handlers are expression attributes", () => {
    const m = parse(`<Card onclick="save()" onCustom="go()" title="x" />`);
    const kinds = m.components[0].attrs.map((a) => [a.name, a.kind]);
    return eq(kinds, [["onclick", "expr"], ["onCustom", "expr"], ["title", "string"]]);
  });

  // Known limitation, pinned so a change to the rule is a visible decision: the
  // handler test is `on` + a letter, with no list of real DOM events behind it,
  // so a prop that merely starts that way is read as an expression too.
  test("a prop starting with `on` is also read as an expression", () => {
    const m = parse(`<Card once="no" />`);
    return eq(m.components[0].attrs[0].kind, "expr");
  });

  test("a `>` inside an arrow function does not end the tag", () => {
    const m = parse(`<Card onclick="() => go()" title="after" />`);
    return eq(m.components[0].attrs.length, 2) && eq(m.components[0].attrs[1].name, "title");
  });

  test("quotes inside an expression attribute do not end the value", () => {
    const m = parse(`<if when="state.tab === 'a' || b == \\"c\\""></if>`);
    return eq(m.flows[0].attrs.length, 1);
  });

  test("an unquoted value is still captured", () => {
    const text = `<Card size=large />`;
    const m = parse(text);
    const a = m.components[0].attrs[0];
    return eq(text.slice(a.strStart, a.strEnd), "large");
  });

  // ── <transition> logic attributes ──────────────────────────────────────────
  section("parser › <transition> logic attributes");

  test("in/out/transition/flip are expressions on <transition>", () => {
    const m = parse(`<transition in="fly({ y: 200 })" out="fade" transition="x" flip="{ duration: 300 }"><p/></transition>`);
    return eq(m.flows[0].attrs.map((a) => a.kind), ["expr", "expr", "expr", "expr"]);
  });

  test("the whole value is one expression, not a partial interpolation", () => {
    const m = parse(`<transition in="fly({ y: 200 })"><p/></transition>`);
    const expr = m.expressions.find((e) => e.text.includes("fly"));
    return eq(expr.text, "fly({ y: 200 })") && eq(expr.braceStart, -1);
  });

  test("the same names stay literal strings on any other tag", () => {
    const m = parse(`<div in="fly" out="fade" flip="x"></div>`);
    return eq(m.expressions.length, 0);
  });

  test("transition lifecycle handlers are expressions", () => {
    const m = parse(`<transition flip onintroend="done()"><p/></transition>`);
    return eq(attrOf(m.flows[0], "onintroend").kind, "expr");
  });

  test("valueless flip is still a boolean attribute", () => {
    const m = parse(`<transition flip><li/></transition>`);
    return eq(attrOf(m.flows[0], "flip").kind, "boolean");
  });

  // ── expressions ────────────────────────────────────────────────────────────
  section("parser › expressions");

  test("text interpolations are captured", () => {
    const m = parse(`<p>{title}</p>`);
    return eq(m.expressions.map((e) => [e.context, e.text]), [["text", "title"]]);
  });

  test("interpolations inside a string attribute are captured", () => {
    const m = parse(`<Card class="a {size} b" />`);
    const e = m.expressions[0];
    return eq(e.context, "attr") && eq(e.text, "size") && ok(e.braceStart > -1);
  });

  test("<log> content is an expression", () => {
    const m = parse(`<log>{state.user}</log>`);
    return eq(m.expressions.map((e) => e.text), ["state.user"]);
  });

  test("an apostrophe inside an interpolation does not break brace matching", () => {
    const m = parse(`<Card c="{t === 'a' ? 'x' : 'y'}" />`);
    return eq(m.expressions.length, 1) && eq(m.expressions[0].text, "t === 'a' ? 'x' : 'y'");
  });

  test("nested braces close at the right place", () => {
    const m = parse(`<p>{ {a: {b: 1}} }</p>`);
    return eq(m.expressions[0].text, " {a: {b: 1}} ");
  });

  test("an unterminated interpolation is recorded, not dropped", () => {
    const m = parse(`<p>{title`);
    return eq(m.expressions.length, 1) && eq(m.expressions[0].braceEnd, -1);
  });

  test("event handlers are flagged", () => {
    const m = parse(`<Card onclick="save()" />`);
    return eq(m.expressions[0].isEventHandler, true);
  });

  // ── identifiers ────────────────────────────────────────────────────────────
  section("parser › identifier extraction");

  test("a bare identifier is a root reference", () => {
    const ids = parseExpression("title", 0);
    return eq(ids.map((i) => [i.name, i.role]), [["title", "root"]]);
  });

  test("member chains record their object", () => {
    const ids = parseExpression("props.todos", 0);
    return eq(ids.map((i) => [i.name, i.role]), [["props", "root"], ["todos", "member"]])
      && eq(ids[1].objectName, "props");
  });

  test("string literals contribute no identifiers", () => {
    return eq(parseExpression("'hello world'", 0).length, 0);
  });

  test("offsets are absolute, honouring the base", () => {
    const ids = parseExpression("title", 100);
    return eq([ids[0].start, ids[0].end], [100, 105]);
  });

  // ── <for> scopes ───────────────────────────────────────────────────────────
  section("parser › <for> scopes");

  test("each=\"x of list\" declares one local", () => {
    const m = parse(`<for each="todo of props.todos"><p>{todo}</p></for>`);
    return eq(names(m.forScopes[0].locals), ["todo"]);
  });

  test("destructured loop headers declare every local", () => {
    const m = parse(`<for each="(item, index) of list"><p>{index}</p></for>`);
    return eq(names(m.forScopes[0].locals), ["item", "index"]);
  });

  test("only the iterable side counts as a reference", () => {
    const m = parse(`<for each="todo of props.todos"></for>`);
    const each = m.expressions.find((e) => e.context === "for-each");
    return eq(each.identifiers.map((i) => i.name), ["props", "todos"]);
  });

  test("a local resolves inside the loop body", () => {
    const text = `<for each="todo of list"><p>{todo}</p></for>`;
    const m = parse(text);
    return eq(anyForScopeDeclares(m, text.indexOf("{todo}") + 1, "todo"), true);
  });

  test("a local does not resolve after the loop closes", () => {
    const text = `<for each="todo of list"></for><p>{todo}</p>`;
    const m = parse(text);
    return eq(anyForScopeDeclares(m, text.lastIndexOf("{todo}") + 1, "todo"), false);
  });

  test("nested loops resolve to the innermost scope", () => {
    const text = `<for each="a of xs"><for each="b of ys"><p>{b}</p></for></for>`;
    const m = parse(text);
    const inner = forScopeAt(m, text.indexOf("{b}") + 1);
    return eq(names(inner.locals), ["b"]);
  });

  test("parseForEach splits locals from the iterable", () => {
    const r = parseForEach("(item, i) of props.list", 0);
    return eq(names(r.locals), ["item", "i"]) && eq(r.iterable.map((x) => x.name), ["props", "list"]);
  });

  // ── raw regions ────────────────────────────────────────────────────────────
  section("parser › script and style regions");

  test("<script> content is a raw region", () => {
    const text = `<script>\n  const a = 1;\n</script><p>{a}</p>`;
    const m = parse(text);
    return eq(isInRawRegion(m, text.indexOf("const a")), true);
  });

  test("template content is not a raw region", () => {
    const text = `<script>const a = 1;</script><p>{a}</p>`;
    const m = parse(text);
    return eq(isInRawRegion(m, text.indexOf("{a}")), false);
  });

  test("<style> content is a raw region", () => {
    const text = `<style>\n.a { color: red; }\n</style>`;
    const m = parse(text);
    return eq(isInRawRegion(m, text.indexOf("color")), true);
  });

  test("a PascalCase name inside <script> is not a component tag", () => {
    const m = parse(`<script>const s = "<Card />";</script>`);
    return eq(m.components.length, 0);
  });

  test("css braces inside <style> are not interpolations", () => {
    const m = parse(`<style>.a { color: red; }</style>`);
    return eq(m.expressions.length, 0);
  });

  test("an unterminated <script> still yields a region", () => {
    const m = parse(`<script>const a = 1;`);
    return eq(m.scriptRegions.length, 1);
  });

  // ── comments and declarations ──────────────────────────────────────────────
  section("parser › comments and declarations");

  test("commented-out markup is skipped", () => {
    const m = parse(`<!-- <Card /> --><Header />`);
    return eq(names(m.components), ["Header"]);
  });

  test("a doctype is skipped", () => {
    const m = parse(`<!doctype html><Header />`);
    return eq(names(m.components), ["Header"]);
  });

  // ── caching ────────────────────────────────────────────────────────────────
  section("parser › lookup helpers");

  test("expressionAt finds the expression under an offset", () => {
    const text = `<p>{title}</p>`;
    const m = parse(text);
    return eq(expressionAt(m, text.indexOf("title")).text, "title");
  });

  test("expressionAt returns null outside every expression", () => {
    const m = parse(`<p>{title}</p>`);
    return eq(expressionAt(m, 1), null);
  });
};
