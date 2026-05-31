/**
 * Find All References / Peek References for template symbols.
 */

import * as vscode from "vscode";
import { componentImports } from "../../components/imports";
import { HTML_SELECTOR } from "../../utils/helpers";
import { rangeFromOffsets } from "../../utils/ranges";
import { OffsetRange, referenceRanges, resolveTarget } from "../resolve";
import { analyze } from "../services";

class OlumReferenceProvider implements vscode.ReferenceProvider {
  provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.ReferenceContext,
  ): vscode.Location[] | null {
    const offset = document.offsetAt(position);
    const { model, symbols } = analyze(document);
    const target = resolveTarget(model, offset);
    if (!target) return null;

    const ranges: OffsetRange[] = referenceRanges(model, target);

    if (context.includeDeclaration) {
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
    }

    const seen = new Set<string>();
    return ranges
      .filter((r) => {
        const k = `${r.start}:${r.end}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map((r) => new vscode.Location(document.uri, rangeFromOffsets(document, r.start, r.end)));
  }
}

export function registerReferenceProvider(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.languages.registerReferenceProvider(HTML_SELECTOR, new OlumReferenceProvider()),
  );
}
