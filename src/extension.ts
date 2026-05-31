/**
 * Extension entry point.
 *
 * Wires VS Code events and language providers to the shared document model:
 *   - decoration highlighting (debounced per document)
 *   - hover / definition / references / rename / completion providers
 *   - diagnostics (debounced)
 *   - "Fix Component Case" command + auto-fix for formatter damage
 *   - a guard that removes spurious auto-closed tags inserted inside `{…}`
 *   - live color updates when `olum.colors.*` settings change
 *
 * All heavy work goes through `getModel`, which parses each document at most
 * once per version, so every feature shares one parse.
 */

import * as vscode from "vscode";
import { caseFixEdits, propQuoteFix, shorthandFix } from "./commands/fixes";
import { updateDiagnostics } from "./diagnostics/diagnostics";
import { createDecorations, DecorationSet, disposeDecorations } from "./highlighting/decorations";
import { highlight } from "./highlighting/highlighter";
import { registerCompletionProvider } from "./language/completion/completionProvider";
import { registerDefinitionProvider } from "./language/definitions/definitionProvider";
import { registerFormattingProvider } from "./language/formatting/formattingProvider";
import { registerHoverProvider } from "./language/hover/hoverProvider";
import { registerReferenceProvider } from "./language/references/referenceProvider";
import { registerRenameProvider } from "./language/rename/renameProvider";
import { getModel, invalidate } from "./parser/documentModel";
import { FLOW_TAG_NAMES } from "./parser/types";
import { escapeRegExp } from "./utils/helpers";
import { getColors } from "./utils/colors";
import { createKeyedDebouncer } from "./utils/debounce";
import { isHtmlDocument, isHtmlEditor } from "./utils/helpers";

// Built once from FLOW_TAG_NAMES so adding a new tag name to types.ts is all
// that is needed — this regex updates automatically.
const SPURIOUS_CLOSE_RE = new RegExp(
  `^<\\/(?:[A-Z][A-Za-z0-9]*|${FLOW_TAG_NAMES.map(escapeRegExp).join("|")})>$`
);

let decorations: DecorationSet | null = null;

export function activate(context: vscode.ExtensionContext): void {
  decorations = createDecorations(getColors());

  const highlightDebouncer = createKeyedDebouncer(60);
  const diagDebouncer = createKeyedDebouncer(250);
  const fixDebouncer = createKeyedDebouncer(300);
  const diagCollection = vscode.languages.createDiagnosticCollection("olum");

  const runHighlight = (editor: vscode.TextEditor | undefined): void => {
    if (!decorations || !isHtmlEditor(editor) || !editor) return;
    highlight(editor, getModel(editor.document), decorations);
  };

  const editorsFor = (doc: vscode.TextDocument): vscode.TextEditor[] =>
    vscode.window.visibleTextEditors.filter((e) => e.document === doc);

  // ── initial render ─────────────────────────────────────────────────────────
  runHighlight(vscode.window.activeTextEditor);
  if (vscode.window.activeTextEditor) {
    updateDiagnostics(vscode.window.activeTextEditor.document, diagCollection);
  }

  // ── language providers ──────────────────────────────────────────────────────
  registerHoverProvider(context);
  registerDefinitionProvider(context);
  registerReferenceProvider(context);
  registerRenameProvider(context);
  registerCompletionProvider(context);
  registerFormattingProvider(context);

  // ── editor / document events ────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      runHighlight(editor);
      if (editor && isHtmlDocument(editor.document)) updateDiagnostics(editor.document, diagCollection);
    }),

    vscode.workspace.onDidChangeTextDocument((event) => {
      const doc = event.document;
      if (!isHtmlDocument(doc)) return;
      const key = doc.uri.toString();

      highlightDebouncer.schedule(key, () => editorsFor(doc).forEach(runHighlight));
      diagDebouncer.schedule(key, () => updateDiagnostics(doc, diagCollection));
      scheduleAutoFix(fixDebouncer, doc);
      removeSpuriousAutoClose(event);
    }),

    vscode.workspace.onDidCloseTextDocument((doc) => {
      invalidate(doc);
      diagCollection.delete(doc.uri);
    }),

    // ── live color updates ────────────────────────────────────────────────────
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("olum.colors")) return;
      if (decorations) disposeDecorations(decorations);
      decorations = createDecorations(getColors());
      vscode.window.visibleTextEditors.forEach(runHighlight);
    }),
  );

  // ── fix component case command ───────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("olum.fixComponentCase", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !isHtmlDocument(editor.document)) return;
      const edits = caseFixEdits(editor.document);
      if (edits.length) editor.edit((eb) => edits.forEach((e) => eb.replace(e.range, e.newText)));
    }),
  );

  context.subscriptions.push(
    diagCollection,
    { dispose: () => { highlightDebouncer.dispose(); diagDebouncer.dispose(); fixDebouncer.dispose(); } },
  );
}

export function deactivate(): void {
  if (decorations) {
    disposeDecorations(decorations);
    decorations = null;
  }
}

/** Debounced auto-fix that undoes common formatter damage. */
function scheduleAutoFix(
  debouncer: ReturnType<typeof createKeyedDebouncer>,
  doc: vscode.TextDocument,
): void {
  debouncer.schedule(doc.uri.toString(), () => {
    const editor = vscode.window.visibleTextEditors.find((e) => e.document === doc);
    if (!editor) return;
    const edits = [...caseFixEdits(doc), ...propQuoteFix(doc), ...shorthandFix(doc)];
    if (edits.length) editor.edit((eb) => edits.forEach((e) => eb.replace(e.range, e.newText)));
  });
}

/**
 * VS Code's built-in HTML auto-close fires on any `>`, including the `>` in `=>`
 * inside an expression. When it inserts a `</Tag>` while the cursor is inside an
 * unclosed `{…}`, remove it immediately.
 */
function removeSpuriousAutoClose(event: vscode.TextDocumentChangeEvent): void {
  if (!isHtmlDocument(event.document)) return;
  for (const change of event.contentChanges) {
    if (!SPURIOUS_CLOSE_RE.test(change.text)) continue;
    const insertPos = change.range.start;
    const before = event.document.lineAt(insertPos.line).text.slice(0, insertPos.character);
    if (before.lastIndexOf("{") <= before.lastIndexOf("}")) continue; // not inside {}

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document !== event.document) continue;

    setTimeout(() => {
      const start = insertPos;
      const end = event.document.positionAt(event.document.offsetAt(insertPos) + change.text.length);
      editor.edit((eb) => eb.delete(new vscode.Range(start, end)));
    }, 0);
    break;
  }
}
