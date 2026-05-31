/**
 * Go-to-definition provider.
 *
 *   import … from "./Header"  → Header.html (Ctrl+Click on the path string)
 *   <Header />               → Header.html (via import spec or sibling convention)
 *   {title}                  → `const title = …` in the <script> block
 *   {props.todos}/{r.x}      → the property declaration inside the object literal
 *   {todo} (for local)       → the `<for each={todo of …}>` binding site
 */

import * as path from "path";
import * as vscode from "vscode";
import { importSpecMap } from "../../components/imports";
import { resolveComponentFile, resolveSpecifier } from "../../components/resolver";
import { HTML_SELECTOR } from "../../utils/helpers";
import { resolveTarget } from "../resolve";
import { analyze } from "../services";

class OlumDefinitionProvider implements vscode.DefinitionProvider {
  provideDefinition(document: vscode.TextDocument, position: vscode.Position): vscode.Definition | null {
    const offset = document.offsetAt(position);
    const { model, symbols } = analyze(document);
    const fromDir = path.dirname(document.uri.fsPath);

    // ── import path string inside <script> ────────────────────────────────────
    // Intentionally bypasses the raw-region guard — we want to navigate from
    // the specifier string ("./Header") to the resolved file.
    for (const decl of symbols.byName.values()) {
      if (decl.kind !== "import" || decl.specStart === undefined || decl.specEnd === undefined) continue;
      if (offset < decl.specStart || offset > decl.specEnd) continue;
      const file = resolveSpecifier(decl.importSpec!, fromDir);
      return file ? new vscode.Location(vscode.Uri.file(file), new vscode.Position(0, 0)) : null;
    }

    const target = resolveTarget(model, offset);
    if (!target) return null;

    const here = (start: number): vscode.Location =>
      new vscode.Location(document.uri, document.positionAt(start));

    switch (target.type) {
      case "component": {
        const spec = importSpecMap(symbols).get(target.name);
        const file = resolveComponentFile(target.name, spec, fromDir);
        return file ? new vscode.Location(vscode.Uri.file(file), new vscode.Position(0, 0)) : null;
      }
      case "variable": {
        const decl = symbols.lookup(target.name);
        if (!decl || decl.nameStart < 0) return null; // implicit / unknown
        return here(decl.nameStart);
      }
      case "member": {
        const member = symbols.lookupMember(target.objectName, target.name);
        return member && member.nameStart >= 0 ? here(member.nameStart) : null;
      }
      case "forLocal": {
        const local = target.scope.locals.find((l) => l.name === target.name) ?? target.scope.locals[0];
        return local ? here(local.start) : null;
      }
    }
  }
}

export function registerDefinitionProvider(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(HTML_SELECTOR, new OlumDefinitionProvider()),
  );
}
