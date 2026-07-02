/**
 * Completion provider.
 *
 *   Inside `{ … }`  → variables/functions in scope (script symbols, implicit
 *                     `props`, and any enclosing `<for>` locals).
 *   After `<`       → component names; workspace `.html` components are offered
 *                     with an auto-import edit inserted into the `<script>` block.
 */

import * as path from "path";
import * as vscode from "vscode";
import { componentImports } from "../../components/imports";
import { forScopeAt, isInRawRegion } from "../../parser/documentModel";
import { ParsedDocument } from "../../parser/types";
import { Declaration, SymbolTable } from "../../scanner/symbols";
import { HTML_SELECTOR, isPascalCase } from "../../utils/helpers";
import { analyze } from "../services";

const KIND_MAP: Partial<Record<Declaration["kind"], vscode.CompletionItemKind>> = {
  function: vscode.CompletionItemKind.Function,
  method: vscode.CompletionItemKind.Method,
  const: vscode.CompletionItemKind.Variable,
  let: vscode.CompletionItemKind.Variable,
  var: vscode.CompletionItemKind.Variable,
  object: vscode.CompletionItemKind.Variable,
  property: vscode.CompletionItemKind.Property,
  prop: vscode.CompletionItemKind.Property,
  class: vscode.CompletionItemKind.Class,
};

class OlumCompletionProvider implements vscode.CompletionItemProvider {
  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.CompletionItem[] | null> {
    const offset = document.offsetAt(position);
    const { model, symbols } = analyze(document);
    if (isInRawRegion(model, offset)) return null;

    const line = document.lineAt(position.line).text;
    const before = line.slice(0, position.character);
    const after = line.slice(position.character);

    // ── inside a {expression} ────────────────────────────────────────────────
    if (before.lastIndexOf("{") > before.lastIndexOf("}") && after.includes("}")) {
      return identifierCompletions(model, symbols, offset);
    }
    if (before.lastIndexOf("{") > before.lastIndexOf("}")) {
      return identifierCompletions(model, symbols, offset);
    }

    // ── after `<` (a component tag is being typed) ───────────────────────────
    const lastAngle = before.lastIndexOf("<");
    if (lastAngle !== -1 && before[lastAngle + 1] !== "/") {
      const afterAngle = before.slice(lastAngle + 1);
      if (afterAngle === "" || /^[A-Z][A-Za-z0-9]*$/.test(afterAngle)) {
        return this.componentCompletions(document, model, symbols);
      }
    }

    return null;
  }

  private async componentCompletions(
    document: vscode.TextDocument,
    model: ParsedDocument,
    symbols: SymbolTable,
  ): Promise<vscode.CompletionItem[]> {
    const items: vscode.CompletionItem[] = [];
    const imported = new Set<string>();

    for (const imp of componentImports(symbols)) {
      imported.add(imp.name);
      const item = new vscode.CompletionItem(imp.name, vscode.CompletionItemKind.Class);
      item.detail = "olum component";
      items.push(item);
    }

    const insert = computeImportInsert(document, model, symbols);
    const dir = path.dirname(document.uri.fsPath);
    const uris = await vscode.workspace.findFiles("**/*.html", "**/node_modules/**", 500);

    for (const uri of uris) {
      const basename = path.basename(uri.fsPath, ".html");
      if (!isPascalCase(basename) || imported.has(basename) || uri.fsPath === document.uri.fsPath) continue;

      let rel = path.relative(dir, uri.fsPath).replace(/\\/g, "/").replace(/\.html$/, "");
      if (!rel.startsWith(".")) rel = "./" + rel;

      const item = new vscode.CompletionItem(basename, vscode.CompletionItemKind.Class);
      item.detail = `auto-import from ${rel}`;
      item.documentation = new vscode.MarkdownString(`Adds \`import ${basename} from "${rel}"\``);
      if (insert) {
        item.additionalTextEdits = [
          vscode.TextEdit.insert(insert.position, `${insert.prefix}import ${basename} from "${rel}";${insert.suffix}`),
        ];
      }
      items.push(item);
    }

    return items;
  }
}

function identifierCompletions(
  model: ParsedDocument,
  symbols: SymbolTable,
  offset: number,
): vscode.CompletionItem[] {
  const items: vscode.CompletionItem[] = [];
  const seen = new Set<string>();
  const add = (name: string, kind: vscode.CompletionItemKind, detail?: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    const item = new vscode.CompletionItem(name, kind);
    if (detail) item.detail = detail;
    items.push(item);
  };

  const scope = forScopeAt(model, offset);
  if (scope) for (const local of scope.locals) add(local.name, vscode.CompletionItemKind.Variable, "<for> local");

  for (const decl of symbols.byName.values()) {
    if (decl.kind === "import" && !isPascalCase(decl.name)) {
      add(decl.name, vscode.CompletionItemKind.Module);
      continue;
    }
    if (decl.kind === "import") continue; // PascalCase imports are components, not values
    add(decl.name, KIND_MAP[decl.kind] ?? vscode.CompletionItemKind.Variable);
  }

  return items;
}

interface ImportInsert {
  position: vscode.Position;
  prefix: string;
  suffix: string;
}

/**
 * Where to insert an auto-import. Prefers appending after the last existing
 * import, otherwise the top of the <script> block; if the document has no
 * <script> block at all, one is created at the top of the document.
 */
function computeImportInsert(
  document: vscode.TextDocument,
  model: ParsedDocument,
  symbols: SymbolTable,
): ImportInsert | null {
  const imports = componentImports(symbols);
  if (imports.length) {
    const lastEnd = Math.max(...imports.map((i) => i.nameEnd));
    const pos = document.positionAt(lastEnd);
    const lineEnd = document.lineAt(pos.line).range.end;
    return { position: lineEnd, prefix: "\n", suffix: "" };
  }
  const script = model.scriptRegions[0];
  if (!script) {
    // No <script> block yet — create one at the top of the document.
    return { position: document.positionAt(0), prefix: "<script>\n  ", suffix: "\n</script>\n\n" };
  }
  const pos = document.positionAt(script.start);
  return { position: pos, prefix: "\n  ", suffix: "" };
}

export function registerCompletionProvider(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(HTML_SELECTOR, new OlumCompletionProvider(), "<", "{"),
  );
}
