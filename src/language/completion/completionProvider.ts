/**
 * Completion provider.
 *
 *   Inside `{ … }`  → variables/functions in scope (script symbols, implicit
 *                     `props`, and any enclosing `<for>` locals).
 *   After `<`       → component names; workspace `.html` components are offered
 *                     with an auto-import edit inserted into the `<script>` block.
 *   Inside `<script>` → every symbol exported by a workspace `.js`/`.ts` file or
 *                     by a package in `dependencies`, each offered with an
 *                     auto-import edit, the way the TypeScript server does it in
 *                     a plain `.js` file. That covers the olum runtime exports
 *                     (`onMount`, `props`, `params`, `store`, …) like any other
 *                     module, so they need no special-casing here.
 */

import * as path from "path";
import * as vscode from "vscode";
import { allImports, componentImports } from "../../components/imports";
import { importableSymbols, ModuleExport, relativeSpecifier } from "../../modules/exports";
import { forScopeAt, isInRawRegion } from "../../parser/documentModel";
import { ParsedDocument } from "../../parser/types";
import { Declaration, SymbolTable } from "../../scanner/symbols";
import { escapeRegExp, HTML_SELECTOR, isPascalCase } from "../../utils/helpers";
import { analyze } from "../services";

/** The olum runtime package. Its exports are script-only, never template values. */
const OLUM_MODULE = "olum";

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
  ): Promise<vscode.CompletionItem[] | vscode.CompletionList | null> {
    const offset = document.offsetAt(position);
    const { model, symbols } = analyze(document);
    const line = document.lineAt(position.line).text;
    const before = line.slice(0, position.character);
    const after = line.slice(position.character);

    if (isInRawRegion(model, offset)) {
      if (!isInScriptRegion(model, offset)) return null; // inside <style> → nothing
      // `{` is a trigger char for markup template expressions; inside <script>
      // it opens an object literal or a block, where an import suggestion is
      // just noise (avoids `const state = {onMount}`).
      if (before.trimEnd().endsWith("{")) return null;
      if (isInsideImportStatement(before)) return null; // VS Code handles the path itself
      const items = await autoImportCompletions(document, model, symbols, wordBefore(before));
      // Marked incomplete so VS Code re-queries as the word grows: the
      // auto-import list is capped, and a longer prefix reaches further into it.
      return new vscode.CompletionList(items, true);
    }

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
    if (decl.kind === "import") {
      // olum runtime helpers (onMount, props, params) are script-only; they are
      // not meaningful values inside a template `{expression}`.
      if (decl.importSpec === OLUM_MODULE) continue;
      // A PascalCase *default* import is a component — offered after `<`, not as
      // a value. A PascalCase *named* import is an ordinary value though
      // (`import { ArrowRight } from "olum-icons"` → `{ArrowRight}`).
      const isComponent = isPascalCase(decl.name) && decl.importKind !== "named" && decl.importKind !== "namespace";
      if (isComponent) continue;
      add(decl.name, vscode.CompletionItemKind.Module);
      continue;
    }
    add(decl.name, KIND_MAP[decl.kind] ?? vscode.CompletionItemKind.Variable);
  }

  return items;
}

/** True when `offset` falls inside a `<script>` body (not a `<style>` one). */
function isInScriptRegion(model: ParsedDocument, offset: number): boolean {
  return model.scriptRegions.some((r) => offset >= r.start && offset < r.end);
}

/** The identifier being typed, i.e. the word ending at the cursor. */
function wordBefore(before: string): string {
  const m = /[A-Za-z_$][\w$]*$/.exec(before);
  return m ? m[0] : "";
}

/**
 * True while the cursor sits in an `import …` statement, where the useful
 * completion is a module path — VS Code's own path IntelliSense — not another
 * import suggestion.
 */
function isInsideImportStatement(before: string): boolean {
  return /^\s*(import|export)\b/.test(before);
}

/** How many auto-import suggestions to offer at once. */
const MAX_AUTO_IMPORTS = 250;

/**
 * Auto-import suggestions for every symbol the workspace exports but this file
 * has not imported yet. Requires at least one typed character: without a prefix
 * the list is meaningless noise on top of the editor's own suggestions.
 */
async function autoImportCompletions(
  document: vscode.TextDocument,
  model: ParsedDocument,
  symbols: SymbolTable,
  prefix: string,
): Promise<vscode.CompletionItem[]> {
  if (prefix.length < 1) return [];

  const fromFile = document.uri.fsPath;
  const fromDir = path.dirname(fromFile);
  // Synthetic symbols (`props`) are implicit in the *template* only — inside
  // `<script>` they still have to be imported, so they must stay suggestible.
  const declared = new Set(
    [...symbols.byName.values()].filter((d) => !d.synthetic).map((d) => d.name),
  );
  const lower = prefix.toLowerCase();

  const items: vscode.CompletionItem[] = [];
  const seen = new Set<string>();

  for (const exp of await importableSymbols(fromFile)) {
    if (declared.has(exp.name)) continue; // already in scope
    if (!exp.name.toLowerCase().startsWith(lower)) continue;

    const spec = exp.spec ?? relativeSpecifier(fromDir, exp.file);
    const key = `${exp.name} ${spec}`;
    if (seen.has(key)) continue;
    seen.add(key);

    items.push(autoImportItem(document, model, symbols, exp, spec));
    if (items.length >= MAX_AUTO_IMPORTS) break;
  }

  return items;
}

function autoImportItem(
  document: vscode.TextDocument,
  model: ParsedDocument,
  symbols: SymbolTable,
  exp: ModuleExport,
  spec: string,
): vscode.CompletionItem {
  const item = new vscode.CompletionItem(
    exp.name,
    isPascalCase(exp.name) ? vscode.CompletionItemKind.Class : vscode.CompletionItemKind.Variable,
  );
  item.detail = `auto-import from ${spec}`;
  const statement = exp.isDefault
    ? `import ${exp.name} from "${spec}"`
    : `import { ${exp.name} } from "${spec}"`;
  item.documentation = new vscode.MarkdownString(`Adds \`${statement}\``);
  // Rank below symbols already in scope, matching how the TS server orders its
  // own auto-imports.
  item.sortText = `zz${exp.name}`;

  const edit = exp.isDefault
    ? defaultImportEdit(document, model, symbols, spec, exp.name)
    : namedImportEdit(document, model, symbols, spec, exp.name);
  if (edit) item.additionalTextEdits = [edit];
  return item;
}

/** An edit adding `import Name from "spec"`, or null when it already exists. */
function defaultImportEdit(
  document: vscode.TextDocument,
  model: ParsedDocument,
  symbols: SymbolTable,
  spec: string,
  name: string,
): vscode.TextEdit | null {
  const insert = computeImportInsert(document, model, symbols);
  if (!insert) return null;
  return vscode.TextEdit.insert(
    insert.position,
    `${insert.prefix}import ${name} from "${spec}";${insert.suffix}`,
  );
}

/**
 * A `TextEdit` that makes `name` available as a named import from `spec`, or
 * `null` when it is already imported. Prefers merging into an existing
 * `import { … } from "<spec>"` statement; otherwise adds a fresh import line.
 */
function namedImportEdit(
  document: vscode.TextDocument,
  model: ParsedDocument,
  symbols: SymbolTable,
  spec: string,
  name: string,
): vscode.TextEdit | null {
  for (const decl of symbols.byName.values()) {
    if (decl.kind === "import" && decl.importSpec === spec && decl.name === name) return null;
  }

  const merge = mergeIntoNamedImport(document, model, spec, name);
  if (merge) return merge;

  const insert = computeImportInsert(document, model, symbols);
  if (!insert) return null;
  return vscode.TextEdit.insert(
    insert.position,
    `${insert.prefix}import { ${name} } from "${spec}";${insert.suffix}`,
  );
}

/**
 * If an `import { … } from "<spec>"` statement already exists, return an edit
 * that adds `name` to its brace group (unless already present). Returns `null`
 * when no such statement exists.
 */
function mergeIntoNamedImport(
  document: vscode.TextDocument,
  model: ParsedDocument,
  spec: string,
  name: string,
): vscode.TextEdit | null {
  const re = new RegExp(`\\bimport\\s*\\{([^}]*)\\}\\s*from\\s*['"]${escapeRegExp(spec)}['"]`, "g");
  for (const region of model.scriptRegions) {
    const src = model.text.slice(region.start, region.end);
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const group = m[1];
      if (new RegExp(`\\b${escapeRegExp(name)}\\b`).test(group)) return null; // already imported

      const groupStart = region.start + m.index + m[0].indexOf("{") + 1;
      const trimmedEnd = group.replace(/\s+$/, "");
      if (trimmedEnd.trim() === "") {
        return vscode.TextEdit.insert(document.positionAt(groupStart), ` ${name} `);
      }
      const insertAt = document.positionAt(groupStart + trimmedEnd.length);
      const text = /,$/.test(trimmedEnd) ? ` ${name}` : `, ${name}`;
      return vscode.TextEdit.insert(insertAt, text);
    }
  }
  return null;
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
  const imports = allImports(symbols);
  if (imports.length) {
    // The specifier ends the statement, so its end is a safer anchor than the
    // binding's — `import { a, b } from "x"` would otherwise anchor on `a`.
    const lastEnd = Math.max(...imports.map((i) => i.specEnd ?? i.nameEnd));
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
