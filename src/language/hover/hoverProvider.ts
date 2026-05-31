/**
 * Hover provider — TypeScript-style tooltips for template symbols.
 */

import * as vscode from "vscode";
import { importSpecMap } from "../../components/imports";
import { buildLabel, Declaration } from "../../scanner/symbols";
import { HTML_SELECTOR } from "../../utils/helpers";
import { rangeFromOffsets } from "../../utils/ranges";
import { resolveTarget } from "../resolve";
import { analyze } from "../services";

class OlumHoverProvider implements vscode.HoverProvider {
  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | null {
    const offset = document.offsetAt(position);
    const { model, symbols } = analyze(document);
    const target = resolveTarget(model, offset);
    if (!target) return null;

    const md = new vscode.MarkdownString();
    md.supportHtml = false;
    const range = rangeFromOffsets(document, target.hit.start, target.hit.end);

    switch (target.type) {
      case "component": {
        const spec = importSpecMap(symbols).get(target.name);
        md.appendCodeblock(`(component) ${target.name}`, "typescript");
        if (spec) md.appendMarkdown(`\nImported from \`${spec}\``);
        return new vscode.Hover(md, range);
      }
      case "variable": {
        const decl = symbols.lookup(target.name);
        if (!decl) return null;
        appendDecl(md, decl);
        return new vscode.Hover(md, range);
      }
      case "member": {
        const member = symbols.lookupMember(target.objectName, target.name);
        if (member) {
          appendDecl(md, member, target.objectName);
          return new vscode.Hover(md, range);
        }
        // Known object (or implicit props) but unknown property → generic.
        if (symbols.lookup(target.objectName)) {
          md.appendCodeblock(`(property) ${target.objectName}.${target.name}: any`, "typescript");
          return new vscode.Hover(md, range);
        }
        return null;
      }
      case "forLocal": {
        md.appendCodeblock(`(local var) ${target.name}: any`, "typescript");
        md.appendMarkdown("\nIteration variable from `<for each>`");
        return new vscode.Hover(md, range);
      }
    }
  }
}

function appendDecl(md: vscode.MarkdownString, decl: Declaration, objectQualifier?: string): void {
  let label = buildLabel(decl);
  if (objectQualifier && (decl.kind === "property" || decl.kind === "method")) {
    label = label.replace(`) ${decl.name}`, `) ${objectQualifier}.${decl.name}`);
  }
  md.appendCodeblock(label, "typescript");
  if (decl.kind === "import" && decl.importSpec) {
    md.appendMarkdown(`\nImported from \`${decl.importSpec}\``);
  }
  if (decl.doc) {
    md.appendMarkdown("\n\n" + decl.doc);
  }
}

export function registerHoverProvider(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(HTML_SELECTOR, new OlumHoverProvider()),
  );
}
