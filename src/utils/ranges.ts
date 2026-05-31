/**
 * Offset to `vscode.Range` conversion helpers.
 *
 * The parser deals only in absolute offsets. These helpers bridge to VS Code's
 * line/character `Position` model. `document.positionAt` is a binary search over
 * the document's line-start table, so this stays cheap even for thousands of
 * ranges per highlight pass.
 */

import * as vscode from "vscode";

export function rangeFromOffsets(
  document: vscode.TextDocument,
  start: number,
  end: number,
): vscode.Range {
  return new vscode.Range(document.positionAt(start), document.positionAt(end));
}

export function offsetAt(document: vscode.TextDocument, position: vscode.Position): number {
  return document.offsetAt(position);
}
