/**
 * Edit producers that repair damage done by generic HTML formatters:
 *
 *   - caseFixEdits   — a formatter may lowercase `<Header>` to `<header>`; this
 *                      restores PascalCase for every imported component.
 *   - propQuoteFix   — a formatter may wrap `onclick={fn}` as `onclick="{fn}"`;
 *                      this unwraps the quotes (brace-depth aware).
 *   - shorthandFix   — a formatter may add an empty value to shorthand props,
 *                      turning `{todo}` into `{todo}=""`; this strips it back.
 *
 * All skip `<script>`/`<style>` regions and return [] when nothing needs fixing
 * so the auto-fix loop terminates after a single pass.
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

export function propQuoteFix(document: vscode.TextDocument): vscode.TextEdit[] {
  const { model } = analyze(document);
  const text = document.getText();
  const edits: vscode.TextEdit[] = [];
  const re = /=(["'])\{/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text))) {
    if (isInRawRegion(model, m.index)) continue;
    const q = m[1];
    let depth = 1;
    let j = m.index + m[0].length;
    while (j < text.length && depth > 0) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}") depth--;
      j++;
    }
    if (depth === 0 && text[j] === q) {
      const inner = text.slice(m.index + 2, j); // includes wrapping { }
      edits.push(vscode.TextEdit.replace(rangeFromOffsets(document, m.index, j + 1), `=${inner}`));
      re.lastIndex = j + 1;
    }
  }
  return edits;
}

export function shorthandFix(document: vscode.TextDocument): vscode.TextEdit[] {
  const { model } = analyze(document);
  const text = document.getText();
  const edits: vscode.TextEdit[] = [];

  let i = 0;
  while (i < text.length) {
    if (text[i] !== "{") { i++; continue; }
    if (isInRawRegion(model, i)) { i++; continue; }

    // Only match in attribute context: { must follow a space or tab
    const prev = text[i - 1];
    if (prev !== " " && prev !== "\t") { i++; continue; }

    // Brace-depth scan to find matching }
    let depth = 1;
    let j = i + 1;
    while (j < text.length && depth > 0) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}") depth--;
      j++;
    }
    if (depth !== 0) { i = j; continue; }
    // j now points to the character right after the closing }

    // Check for ="" or ='' immediately after the closing }
    if (j + 2 < text.length && text[j] === "=") {
      const q = text[j + 1];
      if ((q === '"' || q === "'") && text[j + 2] === q) {
        edits.push(vscode.TextEdit.delete(rangeFromOffsets(document, j, j + 3)));
        i = j + 3;
        continue;
      }
    }

    i = j;
  }

  return edits;
}
