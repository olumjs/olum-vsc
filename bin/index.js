/**
 * Extension entry point.
 *
 * Lifecycle
 * ---------
 * activate()  — called once when VS Code loads the extension (activationEvents: "*")
 *               1. Build TextEditorDecorationType objects from colors.js
 *               2. Run the highlighter immediately on the current editor
 *               3. Re-run whenever the active editor or document text changes
 *
 * deactivate() — no teardown needed; VS Code disposes subscriptions automatically.
 *
 * To reload after editing source files:
 *   Ctrl+Shift+P → "Developer: Reload Window"
 */

const vscode    = require("vscode");
const path      = require("path");
const fs        = require("fs");
const highlight = require("../lib/highlight");
const colors    = require("../lib/colors");

function resolveHtmlPath(importSpecifier, fromDir) {
  const resolved = path.resolve(fromDir, importSpecifier);
  if (fs.existsSync(resolved)) return resolved;
  const withExt = resolved + ".html";
  if (fs.existsSync(withExt)) return withExt;
  return null;
}

function parseImports(text) {
  const map = new Map();
  const re = /import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(text)) !== null) map.set(m[1], m[2]);
  return map;
}

// Infer a primitive type label from a raw value string.
function inferType(raw) {
  const v = (raw || "").trim();
  if (/^['"`]/.test(v))                                 return "string";
  if (/^-?\d+(\.\d+)?$/.test(v))                       return "number";
  if (v === "true" || v === "false")                    return "boolean";
  if (v === "null")                                     return "null";
  if (v === "undefined")                                return "undefined";
  if (v.startsWith("["))                                return "any[]";
  if (v.includes("=>") || v.startsWith("function"))    return "Function";
  if (v.startsWith("{"))                                return "object";
  return "any";
}

// Return hover info for a plain variable (const/let/var, function, import, this.*).
function getVarInfo(text, varName) {
  const esc = varName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Arrow function assigned to variable: const fn = (...) =>
  let m = new RegExp(`\\b(const|let|var)\\s+${esc}\\s*=\\s*(\\([^)]*\\)|\\w+)\\s*=>`).exec(text);
  if (m) {
    const params = m[2].replace(/^\(|\)$/g, "").trim();
    return { kind: "function", name: varName, params };
  }

  // Regular function declaration: function fn(...)
  m = new RegExp(`\\bfunction\\s+${esc}\\s*\\(([^)]*)\\)`).exec(text);
  if (m) return { kind: "function", name: varName, params: m[1].trim() };

  // const / let / var declaration
  m = new RegExp(`\\b(const|let|var)\\s+${esc}\\s*=\\s*([^;\\n,}]+)`).exec(text);
  if (m) return { kind: m[1], name: varName, type: inferType(m[2]) };

  // import default
  if (new RegExp(`\\bimport\\s+${esc}\\s+from`).test(text))
    return { kind: "module", name: varName };

  // import named
  if (new RegExp(`\\bimport\\s*\\{[^}]*\\b${esc}\\b`).test(text))
    return { kind: "import", name: varName };

  // this.prop = value
  m = new RegExp(`\\bthis\\.${esc}\\s*=\\s*([^;\\n]+)`).exec(text);
  if (m) return { kind: "property", name: varName, type: inferType(m[1]) };

  return null;
}

// Return hover info for a property inside an object (e.g. `input` in `const r = { input: ... }`).
function getPropInfo(text, objName, propName) {
  const escObj  = objName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escProp = propName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const objRe = new RegExp(`\\b(?:(?:const|let|var)\\s+${escObj}|this\\.${escObj})\\s*=\\s*\\{`);
  const objM  = objRe.exec(text);
  if (!objM) return null;

  const body  = text.substring(objM.index + objM[0].length);
  const propM = new RegExp(`\\b${escProp}\\s*:\\s*([^,\\n}]+)`).exec(body);
  if (!propM) return null;

  // Distinguish function values from plain values.
  const raw = propM[1].trim();
  if (raw.includes("=>") || raw.startsWith("function")) {
    const paramM = /\(([^)]*)\)/.exec(raw);
    return { kind: "method", name: propName, params: paramM ? paramM[1].trim() : "" };
  }
  return { kind: "property", name: propName, type: inferType(raw) };
}

// Build a VS Code-style label from hover info.
function buildLabel(info) {
  if (!info) return null;
  if (info.kind === "function" || info.kind === "method")
    return `(${info.kind}) ${info.name}(${info.params || ""}): void`;
  if (info.kind === "module")
    return `(module) ${info.name}`;
  if (info.kind === "import")
    return `(import) ${info.name}`;
  return `(${info.kind}) ${info.name}: ${info.type}`;
}

// ── shared helper: resolve the identifier under position inside {} ─────────────
// Returns { wordRange, propName, charBefore, objName } or null.
function resolveIdentInBraces(document, position) {
  const line   = document.lineAt(position.line).text;
  const before = line.substring(0, position.character);
  const after  = line.substring(position.character);
  if (before.lastIndexOf("{") <= before.lastIndexOf("}") || after.indexOf("}") < 0) return null;

  const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z_$][a-zA-Z0-9_$]*/);
  if (!wordRange) return null;

  const propName   = document.getText(wordRange);
  const charBefore = line.charAt(wordRange.start.character - 1);
  let objName      = null;
  if (charBefore === ".") {
    const obj = /[a-zA-Z_$][a-zA-Z0-9_$]*$/.exec(line.substring(0, wordRange.start.character - 1));
    if (obj) objName = obj[0];
  }
  return { wordRange, propName, charBefore, objName };
}

function findVarDefinition(document, varName) {
  const text = document.getText();
  const esc  = varName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`\\b(?:const|let|var)\\s+(${esc})\\b`),
    new RegExp(`\\bfunction\\s+(${esc})\\s*\\(`),
    new RegExp(`\\bimport\\s+(${esc})\\s+from`),
    new RegExp(`\\bimport\\s*\\{[^}]*\\b(${esc})\\b`),
    new RegExp(`\\bthis\\.(${esc})\\s*=`),
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    return document.positionAt(m.index + m[0].indexOf(m[1]));
  }
  return null;
}

function findPropDefinition(document, objName, propName) {
  const text    = document.getText();
  const escObj  = objName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escProp = propName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const objRe = new RegExp(`\\b(?:(?:const|let|var)\\s+${escObj}|this\\.${escObj})\\s*=\\s*\\{`);
  const objM  = objRe.exec(text);
  if (!objM) return null;

  const bodyStart = objM.index + objM[0].length;
  const propM     = new RegExp(`\\b(${escProp})\\s*:`).exec(text.substring(bodyStart));
  if (!propM) return null;

  return document.positionAt(bodyStart + propM.index);
}

const HTML_SELECTOR = { language: "html" };
const PASCAL_WORD   = /[A-Z][A-Za-z0-9]*/;

const activate = context => {
  highlight.createDecorations(colors);
  highlight();

  vscode.window.onDidChangeActiveTextEditor(highlight, null, context.subscriptions);
  vscode.workspace.onDidChangeTextDocument(highlight, null, context.subscriptions);

  // ── Definition provider ────────────────────────────────────────────────────
  const defProvider = vscode.languages.registerDefinitionProvider(HTML_SELECTOR, {
    provideDefinition(document, position) {
      const line = document.lineAt(position.line).text;
      const dir  = path.dirname(document.uri.fsPath);

      // Import line: only respond when cursor is on the path string.
      const imp = /^\s*import\s+\w+\s+from\s+['"]([^'"]+)['"]/.exec(line);
      if (imp) {
        const pathStart = line.lastIndexOf(imp[1]);
        const col       = position.character;
        if (col < pathStart || col > pathStart + imp[1].length) return null;
        const filePath = resolveHtmlPath(imp[1], dir);
        return filePath ? new vscode.Location(vscode.Uri.file(filePath), new vscode.Position(0, 0)) : null;
      }

      // Inside {}: jump to variable/property declaration.
      const ctx = resolveIdentInBraces(document, position);
      if (ctx) {
        const defPos = ctx.objName
          ? findPropDefinition(document, ctx.objName, ctx.propName)
          : findVarDefinition(document, ctx.propName);
        return defPos ? new vscode.Location(document.uri, defPos) : null;
      }

      // Template component tag: open the matching .html file.
      const wordRange = document.getWordRangeAtPosition(position, PASCAL_WORD);
      if (!wordRange) return null;

      const componentName = document.getText(wordRange);
      const specifier     = parseImports(document.getText()).get(componentName);
      if (!specifier) return null;

      const filePath = resolveHtmlPath(specifier, dir);
      return filePath ? new vscode.Location(vscode.Uri.file(filePath), new vscode.Position(0, 0)) : null;
    },
  });

  // ── Hover provider ─────────────────────────────────────────────────────────
  const hoverProvider = vscode.languages.registerHoverProvider(HTML_SELECTOR, {
    provideHover(document, position) {
      const ctx = resolveIdentInBraces(document, position);
      if (!ctx) return null;

      const text = document.getText();
      const info = ctx.objName
        ? getPropInfo(text, ctx.objName, ctx.propName)
        : getVarInfo(text, ctx.propName);

      const label = buildLabel(info);
      if (!label) return null;

      const md = new vscode.MarkdownString();
      md.appendCodeblock(label, "typescript");
      return new vscode.Hover(md, ctx.wordRange);
    },
  });

  context.subscriptions.push(defProvider, hoverProvider);
};

const deactivate = () => {};
exports.activate = activate;
exports.deactivate = deactivate;
