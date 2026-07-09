/**
 * Completion provider.
 *
 *   Inside `{ … }`  → variables/functions in scope (script symbols, implicit
 *                     `props`, and any enclosing `<for>` locals).
 *   After `<`       → component names; workspace `.html` components are offered
 *                     with an auto-import edit inserted into the `<script>` block.
 *   Inside `<script>` → olum runtime helpers (`onMount`, `props`, `params`),
 *                     each offered with an auto-import edit for `import { … }
 *                     from "olum"`. `onMount` additionally expands to its call
 *                     form `onMount(() => { … })`.
 */

import * as path from "path";
import * as vscode from "vscode";
import { componentImports } from "../../components/imports";
import { forScopeAt, isInRawRegion } from "../../parser/documentModel";
import { ParsedDocument } from "../../parser/types";
import { Declaration, SymbolTable } from "../../scanner/symbols";
import { escapeRegExp, HTML_SELECTOR, isPascalCase } from "../../utils/helpers";
import { analyze } from "../services";

/** Module specifier every runtime helper is imported from. */
const OLUM_MODULE = "olum";

/**
 * Named exports the olum runtime provides. Add an entry here to make it
 * auto-importable from `<script>`. When `snippet` is set, selecting the item
 * expands to that snippet (with `$0` as the final cursor) instead of the bare
 * name — useful for callables like `onMount`.
 */
interface RuntimeHelper {
  /** Completion label and default filter word (what you type to trigger it). */
  name: string;
  /** Named export to import from "olum". Defaults to `name`. */
  importName?: string;
  kind: vscode.CompletionItemKind;
  detail: string;
  doc: string;
  snippet?: string;
}

const OLUM_RUNTIME: RuntimeHelper[] = [
  {
    name: "onMount",
    kind: vscode.CompletionItemKind.Function,
    detail: 'olum lifecycle — auto-import from "olum"',
    doc: 'Runs a callback once the component has mounted.\n\nAdds `import { onMount } from "olum"`.',
    snippet: "onMount(() => {\n\t$0\n})",
  },
  {
    name: "props",
    kind: vscode.CompletionItemKind.Snippet,
    detail: 'olum runtime — destructure props(), auto-import from "olum"',
    doc: 'Destructures the component props.\n\nExpands to `const {} = props()` and adds `import { props } from "olum"`.',
    snippet: "const {$1} = props()$0",
  },
  {
    name: "params",
    kind: vscode.CompletionItemKind.Snippet,
    detail: 'olum runtime — destructure params(), auto-import from "olum"',
    doc: 'Destructures the route params.\n\nExpands to `const {} = params()` and adds `import { params } from "olum"`.',
    snippet: "const {$1} = params()$0",
  },
];

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
    const line = document.lineAt(position.line).text;
    const before = line.slice(0, position.character);
    const after = line.slice(position.character);

    if (isInRawRegion(model, offset)) {
      if (!isInScriptRegion(model, offset)) return null; // inside <style> → nothing
      // `{` is a trigger char for markup template expressions; inside <script>
      // it starts an object literal/block, so don't surface runtime helpers
      // (avoids `const state = {onMount}`).
      if (before.trimEnd().endsWith("{")) return null;
      return runtimeCompletions(document, model, symbols);
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
    if (decl.kind === "import" && !isPascalCase(decl.name)) {
      // olum runtime helpers (onMount, props, params) are script-only; they are
      // not meaningful values inside a template `{expression}`.
      if (decl.importSpec === OLUM_MODULE) continue;
      add(decl.name, vscode.CompletionItemKind.Module);
      continue;
    }
    if (decl.kind === "import") continue; // PascalCase imports are components, not values
    add(decl.name, KIND_MAP[decl.kind] ?? vscode.CompletionItemKind.Variable);
  }

  return items;
}

/** True when `offset` falls inside a `<script>` body (not a `<style>` one). */
function isInScriptRegion(model: ParsedDocument, offset: number): boolean {
  return model.scriptRegions.some((r) => offset >= r.start && offset < r.end);
}

/**
 * Completions for the olum runtime helpers (`onMount`, `props`, `params`),
 * each carrying an auto-import edit so selecting one imports it from `"olum"`.
 */
function runtimeCompletions(
  document: vscode.TextDocument,
  model: ParsedDocument,
  symbols: SymbolTable,
): vscode.CompletionItem[] {
  return OLUM_RUNTIME.map((helper) => {
    const item = new vscode.CompletionItem(helper.name, helper.kind);
    item.detail = helper.detail;
    item.documentation = new vscode.MarkdownString(helper.doc);
    if (helper.snippet) item.insertText = new vscode.SnippetString(helper.snippet);
    const edit = olumImportEdit(document, model, symbols, helper.importName ?? helper.name);
    if (edit) item.additionalTextEdits = [edit];
    return item;
  });
}

/**
 * A `TextEdit` that makes `name` available as a named import from `"olum"`,
 * or `null` when it is already imported. Prefers merging into an existing
 * `import { … } from "olum"` statement; otherwise adds a fresh import line.
 */
function olumImportEdit(
  document: vscode.TextDocument,
  model: ParsedDocument,
  symbols: SymbolTable,
  name: string,
): vscode.TextEdit | null {
  for (const decl of symbols.byName.values()) {
    if (decl.kind === "import" && decl.importSpec === OLUM_MODULE && decl.name === name) return null;
  }

  const merge = mergeIntoOlumImport(document, model, name);
  if (merge) return merge;

  const insert = computeImportInsert(document, model, symbols);
  if (!insert) return null;
  return vscode.TextEdit.insert(
    insert.position,
    `${insert.prefix}import { ${name} } from "${OLUM_MODULE}";${insert.suffix}`,
  );
}

/**
 * If a `import { … } from "olum"` statement already exists, return an edit that
 * adds `name` to its brace group (unless already present). Returns `null` when
 * no such statement exists.
 */
function mergeIntoOlumImport(
  document: vscode.TextDocument,
  model: ParsedDocument,
  name: string,
): vscode.TextEdit | null {
  const re = new RegExp(`\\bimport\\s*\\{([^}]*)\\}\\s*from\\s*['"]${escapeRegExp(OLUM_MODULE)}['"]`, "g");
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
