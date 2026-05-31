/**
 * Rename Symbol for template variables, members, `<for>` locals and components.
 *
 * Renames stay within the current document: all template reference ranges plus
 * the matching declaration in the `<script>` block (or the `<for>` binding) are
 * edited together. Renaming a component edits its tag occurrences and the import
 * name — the source file itself is intentionally left untouched.
 */

import * as vscode from "vscode";
import { componentImports } from "../../components/imports";
import { HTML_SELECTOR } from "../../utils/helpers";
import { rangeFromOffsets } from "../../utils/ranges";
import { OffsetRange, referenceRanges, resolveTarget } from "../resolve";
import { analyze } from "../services";

class OlumRenameProvider implements vscode.RenameProvider {
  prepareRename(document: vscode.TextDocument, position: vscode.Position): vscode.Range {
    const offset = document.offsetAt(position);
    const { model } = analyze(document);
    const target = resolveTarget(model, offset);
    if (!target) throw new Error("You cannot rename this element.");
    return rangeFromOffsets(document, target.hit.start, target.hit.end);
  }

  provideRenameEdits(
    document: vscode.TextDocument,
    position: vscode.Position,
    newName: string,
  ): vscode.WorkspaceEdit | null {
    const offset = document.offsetAt(position);
    const { model, symbols } = analyze(document);
    const target = resolveTarget(model, offset);
    if (!target) return null;

    const ranges: OffsetRange[] = referenceRanges(model, target);

    if (target.type === "variable") {
      const decl = symbols.lookup(target.name);
      if (decl && decl.nameStart >= 0) ranges.push({ start: decl.nameStart, end: decl.nameEnd });
    } else if (target.type === "member") {
      const member = symbols.lookupMember(target.objectName, target.name);
      if (member && member.nameStart >= 0) ranges.push({ start: member.nameStart, end: member.nameEnd });
    } else if (target.type === "component") {
      const imp = componentImports(symbols).find((c) => c.name === target.name);
      if (imp) ranges.push({ start: imp.nameStart, end: imp.nameEnd });
    }

    const edit = new vscode.WorkspaceEdit();
    const seen = new Set<string>();
    for (const r of ranges) {
      const k = `${r.start}:${r.end}`;
      if (seen.has(k)) continue;
      seen.add(k);
      edit.replace(document.uri, rangeFromOffsets(document, r.start, r.end), newName);
    }
    return edit;
  }
}

export function registerRenameProvider(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.languages.registerRenameProvider(HTML_SELECTOR, new OlumRenameProvider()),
  );
}
