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

// Try the specifier as-is first (covers "./Foo.html"), then append .html (covers "./Foo").
function resolveHtmlPath(importSpecifier, fromDir) {
  const resolved = path.resolve(fromDir, importSpecifier);
  if (fs.existsSync(resolved)) return resolved;
  const withExt = resolved + ".html";
  if (fs.existsSync(withExt)) return withExt;
  return null;
}

// Returns a Map of { componentName → specifier } for every import statement in text.
function parseImports(text) {
  const map = new Map();
  const re = /import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(text)) !== null) map.set(m[1], m[2]);
  return map;
}

// Heuristic: infer a TypeScript-style type label from a raw value string.
function inferType(raw) {
  const v = (raw || "").trim();
  if (/^['"`]/.test(v))                              return "string";
  if (/^-?\d+(\.\d+)?$/.test(v))                    return "number";
  if (v === "true" || v === "false")                 return "boolean";
  if (v === "null")                                  return "null";
  if (v === "undefined")                             return "undefined";
  if (v.startsWith("["))                             return "any[]";
  if (v.includes("=>") || v.startsWith("function")) return "Function";
  if (v.startsWith("{"))                             return "object";
  return "any";
}

// Return hover info for a plain variable. Arrow-function pattern is tested before
// the generic const/let/var pattern so `const fn = () => {}` gets kind "function"
// rather than kind "const" with type "Function".
function getVarInfo(text, varName) {
  const esc = varName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let m = new RegExp(`\\b(const|let|var)\\s+${esc}\\s*=\\s*(\\([^)]*\\)|\\w+)\\s*=>`).exec(text);
  if (m) return { kind: "function", name: varName, params: m[2].replace(/^\(|\)$/g, "").trim() };
  m = new RegExp(`\\bfunction\\s+${esc}\\s*\\(([^)]*)\\)`).exec(text);
  if (m) return { kind: "function", name: varName, params: m[1].trim() };
  m = new RegExp(`\\b(const|let|var)\\s+${esc}\\s*=\\s*([^;\\n,}]+)`).exec(text);
  if (m) return { kind: m[1], name: varName, type: inferType(m[2]) };
  if (new RegExp(`\\bimport\\s+${esc}\\s+from`).test(text))       return { kind: "module",   name: varName };
  if (new RegExp(`\\bimport\\s*\\{[^}]*\\b${esc}\\b`).test(text)) return { kind: "import",   name: varName };
  m = new RegExp(`\\bthis\\.${esc}\\s*=\\s*([^;\\n]+)`).exec(text);
  if (m) return { kind: "property", name: varName, type: inferType(m[1]) };
  return null;
}

// Return hover info for a property inside an object definition.
// Searches only the text AFTER the object's opening { to avoid matching
// same-named properties in earlier objects.
function getPropInfo(text, objName, propName) {
  const escObj  = objName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escProp = propName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const objRe   = new RegExp(`\\b(?:(?:const|let|var)\\s+${escObj}|this\\.${escObj})\\s*=\\s*\\{`);
  const objM    = objRe.exec(text);
  if (!objM) return null;
  const body  = text.substring(objM.index + objM[0].length);
  const propM = new RegExp(`\\b${escProp}\\s*:\\s*([^,\\n}]+)`).exec(body);
  if (!propM) return null;
  const raw = propM[1].trim();
  if (raw.includes("=>") || raw.startsWith("function")) {
    const paramM = /\(([^)]*)\)/.exec(raw);
    return { kind: "method", name: propName, params: paramM ? paramM[1].trim() : "" };
  }
  return { kind: "property", name: propName, type: inferType(raw) };
}

// Format hover info into a VS Code-style TypeScript signature label.
function buildLabel(info) {
  if (!info) return null;
  if (info.kind === "function" || info.kind === "method")
    return `(${info.kind}) ${info.name}(${info.params || ""}): void`;
  if (info.kind === "module") return `(module) ${info.name}`;
  if (info.kind === "import") return `(import) ${info.name}`;
  return `(${info.kind}) ${info.name}: ${info.type}`;
}

// Shared helper used by both the definition and hover providers.
// Returns { wordRange, propName, charBefore, objName } when the cursor is inside
// a {} expression (single-line or multi-line), or null otherwise.
// objName is set when the pattern is obj.prop.
function resolveIdentInBraces(document, position) {
  const line   = document.lineAt(position.line).text;
  const before = line.substring(0, position.character);
  const after  = line.substring(position.character);

  // Fast path: cursor is visibly between { and } on the same line.
  const onSameLine = before.lastIndexOf("{") > before.lastIndexOf("}") && after.indexOf("}") >= 0;

  // Multi-line path: scan from the document start to the cursor counting net brace
  // depth. Depth > 0 means we're inside an unclosed { } expression.
  let inMultiLine = false;
  if (!onSameLine) {
    let depth = 0;
    for (let li = 0; li <= position.line; li++) {
      const text  = document.lineAt(li).text;
      const limit = li === position.line ? position.character : text.length;
      for (let ci = 0; ci < limit; ci++) {
        if (text[ci] === '{') depth++;
        else if (text[ci] === '}') depth--;
      }
    }
    inMultiLine = depth > 0;
  }

  if (!onSameLine && !inMultiLine) return null;

  const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z_$][a-zA-Z0-9_$]*/);
  if (!wordRange) return null;
  const propName   = document.getText(wordRange);
  const charBefore = line.charAt(wordRange.start.character - 1);
  let objName      = null;
  // Detect property access: the character immediately before the word is "."
  if (charBefore === ".") {
    const obj = /[a-zA-Z_$][a-zA-Z0-9_$]*$/.exec(line.substring(0, wordRange.start.character - 1));
    if (obj) objName = obj[0];
  }
  return { wordRange, propName, charBefore, objName };
}

// Walk the document for the first declaration of varName.
// Pattern order matters: more specific forms (arrow fn, function) come before
// the generic const/let/var so the captured position lands on the name, not the keyword.
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

// Find propName inside the object body of objName. Searching only text after
// the opening { avoids false matches against unrelated objects higher in the file.
function findPropDefinition(document, objName, propName) {
  const text    = document.getText();
  const escObj  = objName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escProp = propName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const objRe   = new RegExp(`\\b(?:(?:const|let|var)\\s+${escObj}|this\\.${escObj})\\s*=\\s*\\{`);
  const objM    = objRe.exec(text);
  if (!objM) return null;
  const bodyStart = objM.index + objM[0].length;
  const propM     = new RegExp(`\\b(${escProp})\\s*:`).exec(text.substring(bodyStart));
  if (!propM) return null;
  return document.positionAt(bodyStart + propM.index);
}

// Build component completion items from imports + unimported workspace .html files.
async function componentCompletions(document) {
  const text    = document.getText();
  const imports = parseImports(text);
  const dir     = path.dirname(document.uri.fsPath);
  const items   = [];

  // Insert position: line after the last existing import (or top of file).
  let insertLine = 0;
  for (let i = 0; i < document.lineCount; i++) {
    if (/^\s*import\s+/.test(document.lineAt(i).text)) insertLine = i + 1;
  }
  const insertPos = new vscode.Position(insertLine, 0);

  // Already-imported components — no extra edit needed.
  for (const [name] of imports) {
    if (!/^[A-Z]/.test(name)) continue;
    const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Class);
    item.detail = "olum component";
    items.push(item);
  }

  // Workspace PascalCase .html files not yet imported — add import on accept.
  const uris = await vscode.workspace.findFiles("**/*.html", "**/node_modules/**");
  for (const uri of uris) {
    const basename = path.basename(uri.fsPath, ".html");
    if (!/^[A-Z]/.test(basename)) continue;
    if (imports.has(basename)) continue;
    if (uri.fsPath === document.uri.fsPath) continue;

    let relPath = path.relative(dir, uri.fsPath).replace(/\\/g, "/").replace(/\.html$/, "");
    if (!relPath.startsWith(".")) relPath = "./" + relPath;

    const item        = new vscode.CompletionItem(basename, vscode.CompletionItemKind.Class);
    item.detail       = `auto-import from ${relPath}`;
    item.documentation = new vscode.MarkdownString(`Adds \`import ${basename} from "${relPath}"\``);
    item.additionalTextEdits = [
      vscode.TextEdit.insert(insertPos, `import ${basename} from "${relPath}"\n`),
    ];
    items.push(item);
  }

  return items;
}

// Build TextEdits that restore PascalCase for any imported component whose tag
// was lowercased by a formatter. Matches both opening and closing tags.
function caseFixEdits(document) {
  const text    = document.getText();
  const imports = parseImports(text);
  const edits   = [];
  for (const [name] of imports) {
    if (!/^[A-Z]/.test(name)) continue;
    const lower = name.toLowerCase();
    const re    = new RegExp(`<(\/?)${lower}(?=[\\s>/])`, "g");
    let m;
    while ((m = re.exec(text)) !== null) {
      const off   = m.index + 1 + m[1].length; // skip < and optional /
      const start = document.positionAt(off);
      const end   = document.positionAt(off + lower.length);
      edits.push(vscode.TextEdit.replace(new vscode.Range(start, end), name));
    }
  }
  return edits;
}

// Build TextEdits that restore ={expr} for any brace-expression prop that a
// formatter wrapped in quotes (e.g. onclick="{handler}" → onclick={handler}).
// Uses a brace-depth counter so nested expressions like ={() => {}} are handled.
// Returns [] when nothing needs fixing, so the debounce loop terminates quickly.
function propQuoteFix(document) {
  const text  = document.getText();
  const edits = [];
  const re    = /=(["'])\{/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const q = m[1]; // " or '
    // Walk forward from after the opening { counting brace depth.
    let depth = 1, j = m.index + m[0].length;
    while (j < text.length && depth > 0) {
      if      (text[j] === '{') depth++;
      else if (text[j] === '}') depth--;
      j++;
    }
    // depth===0 means j is one past the closing }; text[j] must be the same quote.
    if (depth === 0 && text[j] === q) {
      const inner = text.slice(m.index + 2, j); // includes the wrapping { and }
      const start = document.positionAt(m.index);
      const end   = document.positionAt(j + 1);
      edits.push(vscode.TextEdit.replace(new vscode.Range(start, end), `=${inner}`));
      re.lastIndex = j + 1; // skip past the edit to avoid re-matching
    }
  }
  return edits;
}

// Collect completion items for all identifiers declared in the document.
// Arrow-function pattern is scanned before the generic const/let/var pattern
// so `const fn = () => {}` gets kind Function rather than kind Variable.
function identifierCompletions(text) {
  const seen  = new Set();
  const items = [];
  const add   = (name, kind) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    items.push(new vscode.CompletionItem(name, kind));
  };
  let m;
  const arrowRe = /\b(?:const|let|var)\s+([a-zA-Z_$]\w*)\s*=\s*(?:\([^)]*\)|\w+)\s*=>/g;
  while ((m = arrowRe.exec(text)) !== null) add(m[1], vscode.CompletionItemKind.Function);
  const fnRe = /\bfunction\s+([a-zA-Z_$]\w*)\s*\(/g;
  while ((m = fnRe.exec(text)) !== null) add(m[1], vscode.CompletionItemKind.Function);
  const varRe = /\b(?:const|let|var)\s+([a-zA-Z_$]\w*)\b/g;
  while ((m = varRe.exec(text)) !== null) add(m[1], vscode.CompletionItemKind.Variable);
  const thisRe = /\bthis\.([a-zA-Z_$]\w*)\s*=/g;
  while ((m = thisRe.exec(text)) !== null) add(m[1], vscode.CompletionItemKind.Property);
  return items;
}

// Extract prop names (and their offsets within attrsStr) while properly
// skipping string and expression content so values aren't mis-detected.
function extractPropNames(attrsStr) {
  const props = []; // { name, index }
  let i = 0;
  while (i < attrsStr.length) {
    const ch = attrsStr[i];
    if (/\s/.test(ch)) { i++; continue; }

    // = followed by "..." or '...' — skip the whole string value
    if (ch === '=' && i + 1 < attrsStr.length) {
      const nc = attrsStr[i + 1];
      if (nc === '"' || nc === "'") {
        const q = nc; i += 2;
        while (i < attrsStr.length) {
          if (attrsStr[i] === '\\') { i += 2; continue; }
          if (attrsStr[i] === q)    { i++; break; }
          i++;
        }
        continue;
      }
      // = followed by {...} — skip the expression value
      if (nc === '{') {
        let depth = 0; i++;
        while (i < attrsStr.length) {
          if      (attrsStr[i] === '{') depth++;
          else if (attrsStr[i] === '}' && --depth === 0) { i++; break; }
          i++;
        }
        continue;
      }
      i++; continue;
    }

    // Shorthand prop: {name}
    if (ch === '{') {
      const close = attrsStr.indexOf('}', i + 1);
      if (close !== -1) {
        const inner = attrsStr.slice(i + 1, close).trim();
        if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(inner)) {
          props.push({ name: inner, index: i + 1 + attrsStr.slice(i + 1, close).indexOf(inner) });
        }
        i = close + 1;
      } else { i++; }
      continue;
    }

    // Regular prop: identifier followed by =
    if (/[a-zA-Z_$]/.test(ch)) {
      let j = i;
      while (j < attrsStr.length && /[a-zA-Z0-9_$-]/.test(attrsStr[j])) j++;
      if (attrsStr[j] === '=') props.push({ name: attrsStr.slice(i, j), index: i });
      i = j; continue;
    }

    i++;
  }
  return props;
}

// Warn about PascalCase component tags that have no matching import,
// and about duplicate prop names within a single component tag.
function updateDiagnostics(document, collection) {
  if (!/html/i.test(document.languageId)) { collection.delete(document.uri); return; }
  const text    = document.getText();
  const imports = parseImports(text);
  const diags   = [];
  const tagRe   = /<([A-Z][A-Za-z0-9]*)/g;
  let m;

  while ((m = tagRe.exec(text)) !== null) {
    const name    = m[1];
    const nameEnd = m.index + m[0].length;

    // ── missing import ───────────────────────────────────────────────────
    if (!imports.has(name)) {
      const start = document.positionAt(m.index + 1);
      const end   = document.positionAt(m.index + 1 + name.length);
      diags.push(new vscode.Diagnostic(
        new vscode.Range(start, end),
        `'${name}' is used but not imported`,
        vscode.DiagnosticSeverity.Warning
      ));
    }

    // ── duplicate props ──────────────────────────────────────────────────
    // Scan forward to the closing > of this tag (respects nested {} and strings).
    let i = nameEnd, depth = 0, inStr = false, strCh = '', tagEnd = -1;
    while (i < text.length) {
      const c = text[i];
      if (inStr) {
        if (c === '\\') { i += 2; continue; }
        if (c === strCh) inStr = false;
      } else {
        if (c === '"' || c === "'") { inStr = true; strCh = c; }
        else if (c === '{') depth++;
        else if (c === '}') depth--;
        else if (c === '>' && depth === 0) { tagEnd = i; break; }
      }
      i++;
    }

    if (tagEnd === -1) continue;

    const attrsStr = text.slice(nameEnd, tagEnd);
    const seen     = new Map();
    for (const { name: prop, index } of extractPropNames(attrsStr)) {
      if (seen.has(prop)) {
        const abs   = nameEnd + index;
        const start = document.positionAt(abs);
        const end   = document.positionAt(abs + prop.length);
        diags.push(new vscode.Diagnostic(
          new vscode.Range(start, end),
          `Duplicate prop '${prop}'`,
          vscode.DiagnosticSeverity.Warning
        ));
      } else {
        seen.set(prop, index);
      }
    }
  }

  collection.set(document.uri, diags);
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

      const imp = /^\s*import\s+\w+\s+from\s+['"]([^'"]+)['"]/.exec(line);
      if (imp) {
        const pathStart = line.lastIndexOf(imp[1]);
        const col       = position.character;
        if (col < pathStart || col > pathStart + imp[1].length) return null;
        const filePath = resolveHtmlPath(imp[1], dir);
        return filePath ? new vscode.Location(vscode.Uri.file(filePath), new vscode.Position(0, 0)) : null;
      }

      const ctx = resolveIdentInBraces(document, position);
      if (ctx) {
        const defPos = ctx.objName
          ? findPropDefinition(document, ctx.objName, ctx.propName)
          : findVarDefinition(document, ctx.propName);
        return defPos ? new vscode.Location(document.uri, defPos) : null;
      }

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
      const text  = document.getText();
      const info  = ctx.objName ? getPropInfo(text, ctx.objName, ctx.propName) : getVarInfo(text, ctx.propName);
      const label = buildLabel(info);
      if (!label) return null;
      const md = new vscode.MarkdownString();
      md.appendCodeblock(label, "typescript");
      return new vscode.Hover(md, ctx.wordRange);
    },
  });

  // ── Completion provider ────────────────────────────────────────────────────
  // • Inside {}  → variables / functions declared in this document
  // • After <    → imported component names (PascalCase)
  const completionProvider = vscode.languages.registerCompletionItemProvider(
    HTML_SELECTOR,
    {
      async provideCompletionItems(document, position) {
        const line   = document.lineAt(position.line).text;
        const before = line.substring(0, position.character);
        const after  = line.substring(position.character);

        // Inside {} — identifier completions
        if (before.lastIndexOf("{") > before.lastIndexOf("}") && after.indexOf("}") >= 0) {
          return identifierCompletions(document.getText());
        }

        // After < (not </) — component completions with auto-import
        const lastAngle = before.lastIndexOf("<");
        if (lastAngle !== -1 && before[lastAngle + 1] !== "/") {
          const afterAngle = before.slice(lastAngle + 1);
          if (afterAngle === "" || /^[A-Z][A-Za-z0-9]*$/.test(afterAngle)) {
            return componentCompletions(document);
          }
        }

        return null;
      },
    },
    "<", "{"
  );

  // ── Spurious auto-close guard ──────────────────────────────────────────────
  // VS Code's built-in HTML auto-close fires on any '>', including the '>' in '=>'
  // inside prop expressions like onclick={()=>...}. When it inserts </Tag> and the
  // insertion point is inside an unclosed {}, remove it immediately.
  vscode.workspace.onDidChangeTextDocument(e => {
    if (!/html/i.test(e.document.languageId)) return;
    for (const change of e.contentChanges) {
      if (!/^<\/(?:[A-Z][A-Za-z0-9]*|if|else(?:-if)?|for|show)>$/.test(change.text)) continue;

      const insertPos = change.range.start;
      const before    = e.document.lineAt(insertPos.line).text.substring(0, insertPos.character);
      if (before.lastIndexOf("{") <= before.lastIndexOf("}")) continue; // not inside {}

      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document !== e.document) continue;

      // Defer so VS Code finishes applying the current edit before we modify the doc.
      setTimeout(() => {
        const start = insertPos;
        const end   = e.document.positionAt(e.document.offsetAt(insertPos) + change.text.length);
        editor.edit(eb => eb.delete(new vscode.Range(start, end)));
      }, 0);
      break;
    }
  }, null, context.subscriptions);

  // ── Diagnostics ────────────────────────────────────────────────────────────
  // Squiggly warning on any PascalCase tag that has no matching import statement.
  const diagCollection = vscode.languages.createDiagnosticCollection("olum");
  const runDiags       = doc => updateDiagnostics(doc, diagCollection);

  if (vscode.window.activeTextEditor) runDiags(vscode.window.activeTextEditor.document);
  vscode.window.onDidChangeActiveTextEditor(e => e && runDiags(e.document), null, context.subscriptions);
  vscode.workspace.onDidChangeTextDocument(e => runDiags(e.document), null, context.subscriptions);

  // ── Fix component case ─────────────────────────────────────────────────────
  // Command: Olum: Fix Component Case (manual, via Command Palette).
  const fixCaseCmd = vscode.commands.registerCommand("olum.fixComponentCase", () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !/html/i.test(editor.document.languageId)) return;
    const edits = caseFixEdits(editor.document);
    if (edits.length) editor.edit(eb => edits.forEach(e => eb.replace(e.range, e.newText)));
  });

  // Auto-fix: fires after every document change (including formatter runs).
  // Debounced so it doesn't fight the user while they're still typing.
  // Both fix functions return [] when nothing needs changing, so the edit cycle
  // terminates immediately after one pass — no infinite loop.
  let caseFixTimer = null;
  vscode.workspace.onDidChangeTextDocument(e => {
    if (!/html/i.test(e.document.languageId)) return;
    clearTimeout(caseFixTimer);
    caseFixTimer = setTimeout(() => {
      const editor = vscode.window.visibleTextEditors.find(ed => ed.document === e.document);
      if (!editor) return;
      const edits = [...caseFixEdits(e.document), ...propQuoteFix(e.document)];
      if (edits.length) editor.edit(eb => edits.forEach(edit => eb.replace(edit.range, edit.newText)));
    }, 300);
  }, null, context.subscriptions);

  context.subscriptions.push(defProvider, hoverProvider, completionProvider, diagCollection, fixCaseCmd);
};

const deactivate = () => {};
exports.activate = activate;
exports.deactivate = deactivate;
