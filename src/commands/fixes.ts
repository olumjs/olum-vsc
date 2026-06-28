/**
 * Edit producers that repair damage done by generic HTML formatters:
 *
 *   - caseFixEdits   — a formatter may lowercase `<Header>` to `<header>`; this
 *                      restores PascalCase for every imported component.
 *
 * Skips `<script>`/`<style>` regions and returns [] when nothing needs fixing
 * so the auto-fix loop terminates after a single pass.
 *
 * Note: the old `propQuoteFix`/`shorthandFix` repairs were removed when olum
 * moved to the "everything lives inside quotes" syntax — there are no longer any
 * `attr={expr}` or `{shorthand}` attribute forms to restore, and unwrapping
 * `attr="{expr}"` would now corrupt legitimate string interpolations.
 */

import * as vscode from "vscode";
import { componentImports } from "../components/imports";
import { isInRawRegion } from "../parser/documentModel";
import { analyze } from "../language/services";
import { escapeRegExp } from "../utils/helpers";
import { rangeFromOffsets } from "../utils/ranges";

export function caseFixEdits(document: vscode.TextDocument): vscode.TextEdit[] {
  const { model, symbols } = analyze(document);
  const text = document.getText();
  const edits: vscode.TextEdit[] = [];

  for (const imp of componentImports(symbols)) {
    const lower = imp.name.toLowerCase();
    if (lower === imp.name) continue;
    const re = new RegExp(`<(/?)${escapeRegExp(lower)}(?=[\\s>/])`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const off = m.index + 1 + m[1].length;
      if (isInRawRegion(model, off)) continue;
      edits.push(vscode.TextEdit.replace(rangeFromOffsets(document, off, off + lower.length), imp.name));
    }
  }
  return edits;
}
