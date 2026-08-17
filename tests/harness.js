/**
 * Test harness for the olum VS Code extension.
 *
 * The extension is TypeScript compiled to `out/`, and almost every module reaches
 * for `vscode` — a module that only exists inside the editor. Requiring this file
 * first installs a stub for it, so the compiled output can be exercised as plain
 * Node code with no editor, no download and no display.
 *
 * The stub is deliberately thin: it implements the shapes the extension actually
 * constructs (positions, ranges, edits, completion items …) and records the
 * providers registered against it, so a test can call a provider directly.
 *
 * Also here: a mutable in-memory `TextDocument`, and the tiny assertion runner
 * used by every `*.test.js` file — matching the style of the olum compiler's
 * test suite (sections, ✔/✖, a summary, and a non-zero exit on failure).
 */

const Module = require("module");
const path = require("path");

// ── vscode stub ──────────────────────────────────────────────────────────────

class Position {
  constructor(line, character) { this.line = line; this.character = character; }
  isEqual(o) { return o && this.line === o.line && this.character === o.character; }
}

class Range {
  constructor(start, end) { this.start = start; this.end = end; }
  get isEmpty() { return this.start.isEqual(this.end); }
}

class Location {
  constructor(uri, rangeOrPosition) {
    this.uri = uri;
    if (rangeOrPosition instanceof Range) { this.range = rangeOrPosition; this.position = rangeOrPosition.start; }
    else { this.position = rangeOrPosition; this.range = new Range(rangeOrPosition, rangeOrPosition); }
  }
}

class MarkdownString {
  constructor(value = "") { this.value = value; }
  appendCodeblock(code) { this.value += code + "\n"; return this; }
  appendMarkdown(md) { this.value += md; return this; }
}

class Hover {
  constructor(contents, range) { this.contents = contents; this.range = range; }
  /** Flattened text of every content block, for easy assertions. */
  get text() {
    const list = Array.isArray(this.contents) ? this.contents : [this.contents];
    return list.map((c) => (c && c.value !== undefined ? c.value : String(c))).join("\n");
  }
}

class SnippetString {
  constructor(value) { this.value = value; }
}

class CompletionItem {
  constructor(label, kind) { this.label = label; this.kind = kind; }
}

class CompletionList {
  constructor(items, isIncomplete) { this.items = items; this.isIncomplete = isIncomplete; }
}

class Diagnostic {
  constructor(range, message, severity) { this.range = range; this.message = message; this.severity = severity; }
}

class WorkspaceEdit {
  constructor() { this.edits = []; }
  replace(uri, range, newText) { this.edits.push({ uri, range, newText }); }
  /** All replacements, for assertions. */
  get size() { return this.edits.length; }
}

/** Providers registered by the extension, so tests can drive them directly. */
const registered = {
  hover: [], definition: [], reference: [], rename: [], completion: [], formatting: [],
  commands: new Map(),
  diagnosticCollections: [],
};

/** Event listeners the extension subscribed to. */
const listeners = { change: [], close: [], config: [], activeEditor: [] };

const disposable = { dispose() {} };
const on = (bucket) => (cb) => { listeners[bucket].push(cb); return disposable; };

const vscode = {
  Position, Range, Location, MarkdownString, Hover, SnippetString,
  CompletionItem, CompletionList, Diagnostic, WorkspaceEdit,
  Uri: { file: (f) => ({ scheme: "file", fsPath: f, path: f, toString: () => "file://" + f }) },
  TextEdit: {
    replace: (range, newText) => ({ range, newText }),
    insert: (position, newText) => ({ range: new Range(position, position), newText }),
  },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  CompletionItemKind: new Proxy({}, { get: (_t, k) => String(k) }),
  window: {
    visibleTextEditors: [],
    activeTextEditor: undefined,
    createTextEditorDecorationType: (opts) => ({ options: opts, dispose() {} }),
    onDidChangeActiveTextEditor: on("activeEditor"),
  },
  workspace: {
    workspaceFolders: undefined,
    /** Overridden per test; returns `{ fsPath }` entries. */
    findFiles: async () => [],
    getConfiguration: () => ({ get: (_key, fallback) => fallback }),
    createFileSystemWatcher: () => ({
      onDidChange: () => disposable, onDidCreate: () => disposable,
      onDidDelete: () => disposable, dispose() {},
    }),
    onDidChangeTextDocument: on("change"),
    onDidCloseTextDocument: on("close"),
    onDidChangeConfiguration: on("config"),
  },
  languages: {
    createDiagnosticCollection: (name) => {
      const store = new Map();
      const c = {
        name, set: (uri, diags) => store.set(uri.toString(), diags),
        get: (uri) => store.get(uri.toString()), delete: (uri) => store.delete(uri.toString()),
        dispose() {}, _store: store,
      };
      registered.diagnosticCollections.push(c);
      return c;
    },
    registerHoverProvider: (_s, p) => (registered.hover.push(p), disposable),
    registerDefinitionProvider: (_s, p) => (registered.definition.push(p), disposable),
    registerReferenceProvider: (_s, p) => (registered.reference.push(p), disposable),
    registerRenameProvider: (_s, p) => (registered.rename.push(p), disposable),
    registerCompletionItemProvider: (_s, p) => (registered.completion.push(p), disposable),
    registerDocumentFormattingEditProvider: (_s, p) => (registered.formatting.push(p), disposable),
  },
  commands: {
    registerCommand: (id, fn) => (registered.commands.set(id, fn), disposable),
  },
};

const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "vscode") return vscode;
  return realLoad.call(this, request, ...rest);
};

// ── in-memory TextDocument ───────────────────────────────────────────────────

let docSeq = 0;

class Doc {
  constructor(text, fsPath = "/ws/src/Page.html") {
    this.languageId = "html";
    this.version = ++docSeq;
    this.uri = vscode.Uri.file(fsPath);
    this._set(text);
  }

  /** Replace the whole text and bump the version, invalidating the parse cache. */
  setText(text) { this._set(text); this.version = ++docSeq; }

  _set(text) {
    this._text = text;
    this._lines = text.split("\n");
    this._starts = [0];
    let acc = 0;
    for (const line of this._lines) { acc += line.length + 1; this._starts.push(acc); }
  }

  getText(range) {
    if (!range) return this._text;
    return this._text.slice(this.offsetAt(range.start), this.offsetAt(range.end));
  }

  offsetAt(position) {
    return this._starts[position.line] + position.character;
  }

  positionAt(offset) {
    let line = 0;
    while (line + 1 < this._starts.length && this._starts[line + 1] <= offset) line++;
    return new Position(line, offset - this._starts[line]);
  }

  lineAt(n) {
    const text = this._lines[n];
    return { text, range: new Range(new Position(n, 0), new Position(n, text.length)) };
  }

  getWordRangeAtPosition(position, re = /[A-Za-z_$][\w$]*/) {
    const line = this._lines[position.line];
    const global = new RegExp(re.source, "g");
    for (const m of line.matchAll(global)) {
      if (m.index <= position.character && position.character <= m.index + m[0].length) {
        return new Range(new Position(position.line, m.index), new Position(position.line, m.index + m[0].length));
      }
    }
    return undefined;
  }

  /** Position of the first occurrence of `needle`, offset by `delta` characters. */
  posOf(needle, delta = 0) {
    const at = this._text.indexOf(needle);
    if (at === -1) throw new Error(`harness: ${JSON.stringify(needle)} not found in document`);
    return this.positionAt(at + delta);
  }

  /** Offset of the first occurrence of `needle`, offset by `delta` characters. */
  offsetOf(needle, delta = 0) {
    const at = this._text.indexOf(needle);
    if (at === -1) throw new Error(`harness: ${JSON.stringify(needle)} not found in document`);
    return at + delta;
  }
}

/** An editor over `doc` whose `edit()` applies to the document in place. */
function makeEditor(doc) {
  return {
    document: doc,
    setDecorations(type, ranges) { (this.decorations ||= new Map()).set(type, ranges); },
    edit(callback) {
      const edits = [];
      callback({
        replace: (range, newText) => edits.push({ range, newText }),
        insert: (position, newText) => edits.push({ range: new Range(position, position), newText }),
        delete: (range) => edits.push({ range, newText: "" }),
      });
      const sorted = [...edits].sort((a, b) => doc.offsetAt(b.range.start) - doc.offsetAt(a.range.start));
      let text = doc.getText();
      for (const e of sorted) {
        text = text.slice(0, doc.offsetAt(e.range.start)) + e.newText + text.slice(doc.offsetAt(e.range.end));
      }
      doc.setText(text);
      return Promise.resolve(true);
    },
  };
}

/** Point the stub at a workspace root and make `findFiles` return real files. */
function useWorkspace(root, files = {}) {
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: path.basename(root), index: 0 }];
  vscode.workspace.findFiles = async (glob) => {
    const list = glob.includes("html") ? files.html || [] : files.scripts || [];
    return list.map((f) => vscode.Uri.file(f));
  };
}

// ── assertion runner ─────────────────────────────────────────────────────────

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s) => paint("32", s);
const red = (s) => paint("31", s);
const dim = (s) => paint("2", s);
const bold = (s) => paint("1", s);
const cyan = (s) => paint("36", s);

const stats = { passed: 0, failed: 0, failures: [] };
let currentSection = "(no section)";

function section(name) {
  currentSection = name;
  console.log("\n" + bold(cyan(name)));
}

/** Run `fn`; it passes when it returns a truthy value and throws nothing. */
function test(name, fn) {
  let ok = false;
  let detail = "";
  try {
    const result = fn();
    ok = result !== false && result !== undefined;
    if (result === undefined) detail = " (assertion returned undefined)";
  } catch (e) {
    detail = " (threw: " + e.message + ")";
  }
  if (ok) {
    stats.passed++;
    console.log("  " + green("✔") + " " + name);
  } else {
    stats.failed++;
    stats.failures.push({ section: currentSection, name, detail });
    console.log("  " + red("✖") + " " + name + dim(detail));
  }
}

/** Async variant of `test`, awaited by the runner. */
async function testAsync(name, fn) {
  let ok = false;
  let detail = "";
  try {
    const result = await fn();
    ok = result !== false && result !== undefined;
    if (result === undefined) detail = " (assertion returned undefined)";
  } catch (e) {
    detail = " (threw: " + e.message + ")";
  }
  if (ok) {
    stats.passed++;
    console.log("  " + green("✔") + " " + name);
  } else {
    stats.failed++;
    stats.failures.push({ section: currentSection, name, detail });
    console.log("  " + red("✖") + " " + name + dim(detail));
  }
}

/** Deep-equality assertion that reports both sides when it fails. */
function eq(actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`expected ${b}, got ${a}`);
  return true;
}

/** Truthiness assertion with a message. */
function ok(value, message = "expected a truthy value") {
  if (!value) throw new Error(message);
  return true;
}

function summary() {
  const total = stats.passed + stats.failed;
  console.log("\n" + bold("─".repeat(52)));
  if (stats.failed === 0) {
    console.log(bold(green(`  ${stats.passed}/${total} passed`)));
  } else {
    console.log(bold(red(`  ${stats.failed} failed`)) + dim(`, ${stats.passed} passed, ${total} total`));
    for (const f of stats.failures) console.log("  " + red("✖") + " " + dim(f.section + " › ") + f.name + dim(f.detail));
  }
  console.log(bold("─".repeat(52)));
  return stats.failed === 0;
}

module.exports = {
  vscode, registered, listeners,
  Doc, makeEditor, useWorkspace,
  section, test, testAsync, eq, ok, summary, stats,
  OUT: path.join(__dirname, "..", "out"),
  FIXTURES: path.join(__dirname, "fixtures"),
};
