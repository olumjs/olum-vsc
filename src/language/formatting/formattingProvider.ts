/**
 * DocumentFormattingEditProvider for olum components.
 *
 * Uses js-beautify instead of Prettier because Prettier mis-parses framework
 * attributes like `each={todo of props.todos}` (unquoted value with spaces)
 * and `when={a=='b' || c}` (single-quoted strings inside the expression).
 * js-beautify leaves these attribute forms intact while still fixing indentation.
 *
 * VS Code will show this as "Olum" in the formatter picker. To make it the
 * default for HTML, add to settings.json:
 *   "[html]": { "editor.defaultFormatter": "eissapk.olum" }
 */

import * as vscode from "vscode";
import { html as beautifyHtml } from "js-beautify";
import { isHtmlDocument } from "../../utils/helpers";

export function registerFormattingProvider(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.languages.registerDocumentFormattingEditProvider(
      { language: "html" },
      { provideDocumentFormattingEdits }
    )
  );
}

function provideDocumentFormattingEdits(
  document: vscode.TextDocument,
  options: vscode.FormattingOptions
): vscode.TextEdit[] {
  if (!isHtmlDocument(document)) return [];

  const text = document.getText();
  const cfg = vscode.workspace.getConfiguration("html.format");

  const formatted = beautifyHtml(text, {
    indent_size: options.insertSpaces ? options.tabSize : 1,
    indent_char: options.insertSpaces ? " " : "\t",
    wrap_line_length: cfg.get<number>("wrapLineLength", 120),
    content_unformatted: cfg.get<string[]>("contentUnformatted", ["pre", "textarea"]),
    unformatted: cfg.get<string[]>("unformatted", []),
    indent_handlebars: false,
    end_with_newline: cfg.get<boolean>("endWithNewline", false),
    extra_liners: cfg.get<string[]>("extraLiners", []),
    wrap_attributes: (cfg.get<string>("wrapAttributes", "auto") as "auto" | "force" | "force-aligned" | "force-expand-multiline" | "aligned-multiple" | "preserve" | "preserve-aligned"),
    max_preserve_newlines: cfg.get<number>("maxPreserveNewLines", 32786),
    preserve_newlines: true,
  });

  if (formatted === text) return [];

  const fullRange = new vscode.Range(
    document.positionAt(0),
    document.positionAt(text.length)
  );
  return [vscode.TextEdit.replace(fullRange, formatted)];
}
