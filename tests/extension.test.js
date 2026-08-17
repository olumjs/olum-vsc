/**
 * Extension wiring: activation, the events it subscribes to, the debounced
 * auto-fix pass, and the auto-close guard — driven by firing the same events
 * VS Code would fire.
 */

const path = require("path");
const {
  section, test, testAsync, eq, ok,
  vscode, registered, listeners, Doc, makeEditor, useWorkspace, OUT, FIXTURES,
} = require("./harness");

const WS = path.join(FIXTURES, "ws");
const PAGE = path.join(WS, "src/components/Page.html");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fire a document-change event shaped like the ones VS Code sends. */
function fireChange(doc, contentChanges = []) {
  for (const cb of listeners.change) cb({ document: doc, contentChanges });
}

module.exports = async function run() {
  useWorkspace(WS, { scripts: [], html: [] });

  const extension = require(OUT + "/extension");
  const doc = new Doc(`<script>\nimport Card from "./Card";\n</script>\n<Card />`, PAGE);
  const editor = makeEditor(doc);
  vscode.window.visibleTextEditors = [editor];
  vscode.window.activeTextEditor = editor;

  section("extension › activation");

  const context = { subscriptions: [] };
  test("activate() completes without throwing", () => {
    extension.activate(context);
    return true;
  });

  test("every language provider is registered", () => ok(
    registered.hover.length && registered.definition.length && registered.reference.length &&
    registered.rename.length && registered.completion.length && registered.formatting.length,
  ));

  test("the fix-component-case command is registered", () =>
    ok(registered.commands.has("olum.fixComponentCase")));

  test("a diagnostic collection is created", () =>
    ok(registered.diagnosticCollections.length > 0));

  test("disposables are collected for cleanup", () => ok(context.subscriptions.length > 0));

  test("decorations are applied on activation", () =>
    ok(editor.decorations && editor.decorations.size > 0));

  section("extension › the fix command");

  test("running the command repairs a lowercased component tag", async () => {
    const target = new Doc(`<script>\nimport Card from "./Card";\n</script>\n<card></card>`, PAGE);
    const targetEditor = makeEditor(target);
    vscode.window.visibleTextEditors = [targetEditor];
    vscode.window.activeTextEditor = targetEditor;
    registered.commands.get("olum.fixComponentCase")();
    const fixed = target.getText().includes("<Card></Card>");
    vscode.window.visibleTextEditors = [editor];
    vscode.window.activeTextEditor = editor;
    return ok(fixed);
  });

  test("the command leaves a real HTML element alone", () => {
    const target = new Doc(`<script>\nimport Button from "./Button";\n</script>\n<button>x</button>`, PAGE);
    const targetEditor = makeEditor(target);
    vscode.window.visibleTextEditors = [targetEditor];
    vscode.window.activeTextEditor = targetEditor;
    registered.commands.get("olum.fixComponentCase")();
    const unchanged = target.getText().includes("<button>x</button>");
    vscode.window.visibleTextEditors = [editor];
    vscode.window.activeTextEditor = editor;
    return ok(unchanged);
  });

  section("extension › document events");

  await testAsync("editing re-runs highlighting", async () => {
    const target = new Doc(`<p>{a}</p>`, PAGE);
    const targetEditor = makeEditor(target);
    vscode.window.visibleTextEditors = [targetEditor];
    fireChange(target);
    await wait(120);
    const painted = targetEditor.decorations && targetEditor.decorations.size > 0;
    vscode.window.visibleTextEditors = [editor];
    return ok(painted);
  });

  await testAsync("editing re-runs diagnostics", async () => {
    const target = new Doc(`<Missing />`, PAGE);
    const targetEditor = makeEditor(target);
    vscode.window.visibleTextEditors = [targetEditor];
    const collection = registered.diagnosticCollections[0];
    fireChange(target);
    await wait(400);
    const diags = collection.get(target.uri) || [];
    vscode.window.visibleTextEditors = [editor];
    return eq(diags.length, 1);
  });

  await testAsync("the debounced auto-fix repairs a lowercased component tag", async () => {
    const target = new Doc(`<script>\nimport Card from "./Card";\n</script>\n<card />`, PAGE);
    const targetEditor = makeEditor(target);
    vscode.window.visibleTextEditors = [targetEditor];
    fireChange(target);
    await wait(500);
    const fixed = target.getText().includes("<Card />");
    vscode.window.visibleTextEditors = [editor];
    return ok(fixed);
  });

  await testAsync("the auto-fix settles instead of looping", async () => {
    const target = new Doc(`<script>\nimport Card from "./Card";\n</script>\n<Card />`, PAGE);
    const targetEditor = makeEditor(target);
    vscode.window.visibleTextEditors = [targetEditor];
    const before = target.version;
    fireChange(target);
    await wait(500);
    const unchanged = target.version === before;
    vscode.window.visibleTextEditors = [editor];
    return ok(unchanged, "an already-correct document must produce no edits");
  });

  await testAsync("non-html documents are ignored", async () => {
    const other = new Doc(`<card />`, "/ws/notes.md");
    other.languageId = "markdown";
    fireChange(other);
    await wait(400);
    return eq(other.getText(), `<card />`);
  });

  section("extension › spurious auto-close guard");

  /**
   * Simulate VS Code auto-inserting `inserted` at the point where it already
   * sits in `text`, then report the document once the guard has had its turn.
   */
  async function autoClose(text, inserted) {
    const target = new Doc(text, PAGE);
    const targetEditor = makeEditor(target);
    vscode.window.visibleTextEditors = [targetEditor];
    vscode.window.activeTextEditor = targetEditor;

    const at = text.indexOf(inserted);
    fireChange(target, [{
      range: new vscode.Range(target.positionAt(at), target.positionAt(at)),
      rangeOffset: at, rangeLength: 0, text: inserted,
    }]);
    await wait(120);

    const result = target.getText();
    vscode.window.visibleTextEditors = [editor];
    vscode.window.activeTextEditor = editor;
    return result;
  }

  // The editor auto-closes on any `>`, including the one in `=>`. Inside an
  // unclosed `{…}` that insertion is always wrong.
  await testAsync("a component tag auto-closed inside `{}` is removed", async () =>
    eq(await autoClose(`<Card>{list.map(x => </Card>`, "</Card>"), `<Card>{list.map(x => `));

  await testAsync("a flow tag auto-closed inside `{}` is removed", async () =>
    eq(await autoClose(`<if when="a">{list.map(x => </if>`, "</if>"), `<if when="a">{list.map(x => `));

  await testAsync("a legitimate closing tag is kept", async () =>
    eq(await autoClose(`<Card>hello</Card>`, "</Card>"), `<Card>hello</Card>`));

  await testAsync("a closing tag after a finished interpolation is kept", async () =>
    eq(await autoClose(`<Card>{title}</Card>`, "</Card>"), `<Card>{title}</Card>`));

  await testAsync("a plain HTML closing tag is never touched", async () =>
    eq(await autoClose(`<div>{list.map(x => </div>`, "</div>"), `<div>{list.map(x => </div>`));

  section("extension › deactivation");

  test("deactivate() disposes cleanly", () => {
    extension.deactivate();
    return true;
  });
};
