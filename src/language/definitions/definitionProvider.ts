/**
 * Go-to-definition provider.
 *
 *   import … from "./Header"  → Header.html (Ctrl+Click on the path string)
 *   import { cart } from "…"  → the `export const cart` line in cart.js
 *                               (Ctrl+Click on either the binding or the path)
 *   <Header />               → Header.html (via import spec or sibling convention)
 *   {title}                  → `const title = …` in the <script> block
 *   {props.todos}/{r.x}      → the property declaration inside the object literal
 *   {todo} (for local)       → the `<for each={todo of …}>` binding site
 *
 * Import navigation deliberately works from anywhere inside `<script>`, not just
 * on the specifier string: clicking the imported name is what a `.js` file does,
 * and landing on the exported symbol beats landing on line 1.
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { importSpecMap } from "../../components/imports";
import { resolveComponentFile } from "../../components/resolver";
import { exportOffset } from "../../modules/exports";
import { resolveModule } from "../../modules/resolver";
import { isInRawRegion } from "../../parser/documentModel";
import { Declaration } from "../../scanner/symbols";
import { HTML_SELECTOR, isPascalCase } from "../../utils/helpers";
import { resolveTarget } from "../resolve";
import { analyze } from "../services";

const IDENTIFIER_RE = /[A-Za-z_$][\w$]*/;

class OlumDefinitionProvider implements vscode.DefinitionProvider {
  provideDefinition(document: vscode.TextDocument, position: vscode.Position): vscode.Definition | null {
    const offset = document.offsetAt(position);
    const { model, symbols } = analyze(document);
    const fromDir = path.dirname(document.uri.fsPath);

    // ── import navigation inside <script> ────────────────────────────────────
    // Intentionally bypasses the raw-region guard: `<script>` is excluded from
    // framework analysis, but imports are exactly what we want to follow there.
    const imports = [...symbols.byName.values()].filter(
      (d): d is Declaration & { importSpec: string } => d.kind === "import" && !!d.importSpec,
    );

    for (const decl of imports) {
      const onSpecifier =
        decl.specStart !== undefined && decl.specEnd !== undefined &&
        offset >= decl.specStart && offset <= decl.specEnd;
      const onBinding = offset >= decl.nameStart && offset <= decl.nameEnd;
      if (!onSpecifier && !onBinding) continue;
      // Clicking the path opens the module; clicking the binding jumps to the
      // symbol it refers to inside that module.
      return locateImport(decl, fromDir, onSpecifier);
    }

    // A use of an imported binding elsewhere in <script> navigates the same way.
    if (isInRawRegion(model, offset)) {
      const wordRange = document.getWordRangeAtPosition(position, IDENTIFIER_RE);
      if (!wordRange) return null;
      const decl = symbols.lookup(document.getText(wordRange));
      if (!decl || decl.kind !== "import" || !decl.importSpec) return null;
      return locateImport(decl as Declaration & { importSpec: string }, fromDir, false);
    }

    const target = resolveTarget(model, offset);
    if (!target) return null;

    const here = (start: number): vscode.Location =>
      new vscode.Location(document.uri, document.positionAt(start));

    switch (target.type) {
      case "component": {
        const spec = importSpecMap(symbols).get(target.name);
        const file = resolveComponentFile(target.name, spec, fromDir);
        return file ? fileLocation(file, 0) : null;
      }
      case "variable": {
        const decl = symbols.lookup(target.name);
        if (!decl) return null;
        if (decl.kind === "import" && decl.importSpec) {
          return locateImport(decl as Declaration & { importSpec: string }, fromDir, false);
        }
        if (decl.nameStart < 0) return null; // implicit / unknown
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

/**
 * Resolve an import declaration to a file location. `topOnly` opens the module
 * at line 1 (what clicking the path string should do); otherwise we try to land
 * on the exported symbol the binding refers to.
 */
function locateImport(
  decl: Declaration & { importSpec: string },
  fromDir: string,
  topOnly: boolean,
): vscode.Location | null {
  // A PascalCase default import is a component by convention, so `.html`
  // candidates are tried first; everything else is script-flavoured.
  const prefer = decl.importKind !== "named" && isPascalCase(decl.name) ? "html" : "script";
  const file = resolveModule(decl.importSpec, fromDir, prefer);
  if (!file) return null;
  if (topOnly || decl.importKind === "namespace" || file.endsWith(".html")) return fileLocation(file, 0);

  const wanted = decl.exportName ?? decl.name;
  const offset = exportOffset(file, wanted, decl.importKind === "default");
  return fileLocation(file, offset < 0 ? 0 : offset);
}

/** A `Location` at a byte offset inside a file we have not opened as a document. */
function fileLocation(file: string, offset: number): vscode.Location {
  const uri = vscode.Uri.file(file);
  if (offset <= 0) return new vscode.Location(uri, new vscode.Position(0, 0));
  return new vscode.Location(uri, positionAtOffset(file, offset));
}

/** Convert an absolute offset in `file` into a line/character position. */
function positionAtOffset(file: string, offset: number): vscode.Position {
  const text = safeRead(file);
  if (text === null) return new vscode.Position(0, 0);
  const before = text.slice(0, offset);
  const line = before.split("\n").length - 1;
  const character = offset - (before.lastIndexOf("\n") + 1);
  return new vscode.Position(line, character);
}

function safeRead(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function registerDefinitionProvider(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(HTML_SELECTOR, new OlumDefinitionProvider()),
  );
}
