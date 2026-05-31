/**
 * Diagnostics:
 *   - PascalCase component tag used without a matching import
 *   - duplicate prop names on a single component tag (incl. shorthand vs `name=`)
 *
 * All structural information comes from the shared model, so diagnostics stay in
 * sync with highlighting and navigation.
 */

import * as vscode from "vscode";
import { importSpecMap } from "../components/imports";
import { rangeFromOffsets } from "../utils/ranges";
import { analyze } from "../language/services";

export function updateDiagnostics(
  document: vscode.TextDocument,
  collection: vscode.DiagnosticCollection,
): void {
  if (!/html/i.test(document.languageId)) {
    collection.delete(document.uri);
    return;
  }

  const { model, symbols } = analyze(document);
  const imports = importSpecMap(symbols);
  const diags: vscode.Diagnostic[] = [];

  for (const tag of model.components) {
    if (tag.isClosing) continue;

    if (!imports.has(tag.name)) {
      diags.push(new vscode.Diagnostic(
        rangeFromOffsets(document, tag.nameStart, tag.nameEnd),
        `'${tag.name}' is used but not imported`,
        vscode.DiagnosticSeverity.Warning,
      ));
    }

    const seen = new Set<string>();
    for (const attr of tag.attrs) {
      if (seen.has(attr.name)) {
        diags.push(new vscode.Diagnostic(
          rangeFromOffsets(document, attr.nameStart, attr.nameEnd),
          `Duplicate prop '${attr.name}'`,
          vscode.DiagnosticSeverity.Warning,
        ));
      } else {
        seen.add(attr.name);
      }
    }
  }

  collection.set(document.uri, diags);
}
