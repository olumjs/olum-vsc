# Olum VS Code Extension — Maintenance Guide

The extension provides syntax highlighting, formatting, IntelliSense (hover,
go-to-definition, references, rename, completion) and diagnostics for the
[olum](https://github.com/olumjs) framework, whose components are `.html` files
with template markup plus a `<script>` block.

It is written in **TypeScript** and compiled to `out/`. The compiled
`out/extension.js` is the entry point (`main` in `package.json`).

```bash
npm install      # install deps (typescript, @types/vscode, @types/node, js-beautify, …)
npm run compile  # build src/ → out/
npm run watch    # incremental rebuilds while developing
npm run typecheck
```

To test changes: build, then `Developer: Reload Window`.

---

## Mental model

An olum component file is treated like a React `.jsx` file:

- The **template** is the markup (everything outside `<script>`/`<style>`).
- The **module scope** lives in the `<script>` block: `import`s and declarations.
- Template `{expressions}` reference symbols from that scope, plus implicit
  `props` and any `<for>` locals in scope.

`<script>` and `<style>` bodies are **never** treated as template: no
highlighting, hover, references or rename fire there. Two exceptions inside
`<script>`:

- **Go-to-definition on import path strings** — Ctrl+Click on `"./Header"`
  navigates to the component file.
- **Runtime-helper completion** — typing an olum runtime export (`onMount`,
  `props`, `params`) offers an auto-importing snippet completion (see
  `OLUM_RUNTIME` in `language/completion/completionProvider.ts`). `<style>`
  bodies still get nothing.

The `<script>` block **is** the symbol source that powers navigation *from*
the template.

---

## Architecture

A single parser produces one `ParsedDocument` per document version; every
feature consumes it. This is the key change from the old design, which had two
independent regex engines (`bin/index.js` and `lib/getRange.js`) that drifted
apart.

```
src/
├─ parser/                  Pure, offset-based, no vscode import
│   ├─ types.ts             Shared data shapes (ParsedDocument, etc.)
│   ├─ expression.ts        JS-like expression → identifier references
│   ├─ scanner.ts           Structural HTML walk (tags, expr attrs, {…} interpolations, raw blocks)
│   └─ documentModel.ts     Orchestration + per-version cache + scope resolution
├─ scanner/                 <script> symbol table
│   ├─ symbols.ts           Declaration model, type inference, hover labels
│   └─ scriptScope.ts       Builds the symbol table from <script> regions
├─ components/
│   ├─ imports.ts           Component imports derived from the symbol table
│   └─ resolver.ts          Component name → source file on disk (workspace-sandboxed)
├─ language/
│   ├─ resolve.ts           "What symbol is at this offset?" + reference ranges
│   ├─ services.ts          Cached { model, symbols } per document
│   ├─ hover/               Hover provider
│   ├─ definitions/         Go-to-definition provider (template + import paths)
│   ├─ references/          Find-references provider
│   ├─ rename/              Rename provider
│   ├─ completion/          Completion provider (identifiers + components + olum runtime helpers)
│   └─ formatting/          Document formatting provider (js-beautify based)
├─ highlighting/
│   ├─ decorations.ts       TextEditorDecorationType per color bucket
│   ├─ exprTokens.ts        Expression tokenizer for coloring
│   └─ highlighter.ts       Maps the model → decoration ranges
├─ commands/
│   └─ fixes.ts             Post-formatter auto-repair edits
├─ diagnostics/
│   └─ diagnostics.ts       Missing-import + duplicate-prop warnings
├─ utils/
│   ├─ colors.ts            All colors in one place
│   ├─ ranges.ts            offset → vscode.Range
│   ├─ helpers.ts           Predicates, selector, regex escape
│   └─ debounce.ts          Per-document trailing debounce
└─ extension.ts             Activation: wires events + providers
```

### Data flow

```
TextDocument ──getModel()──► ParsedDocument (cached by version)
                                  │
        ┌─────────────────────────┼───────────────────────────┐
        ▼                         ▼                           ▼
  highlighter            language/resolve.ts            diagnostics
  (decorations)        (hover/def/refs/rename)      (missing import, …)
                                  │
                          scriptScope.buildSymbolTable
                          (declarations from <script>)
```

The parser works on **absolute offsets**, so multi-line tags and multi-line
expressions need no special handling — they are just longer ranges. Offsets are
converted to `vscode.Position`/`Range` only at the edges (`utils/ranges.ts`).

---

## Formatting

The extension registers a `DocumentFormattingEditProvider` (`language/formatting/formattingProvider.ts`)
that uses **js-beautify** to format HTML files, reading VS Code's `html.format.*`
settings so user preferences are respected. Because every olum value now lives
inside quotes (`each="todo of list"`, `when="a == 'b' || c"`), generic HTML
formatters no longer split it into broken attributes — but js-beautify is still
used for consistent, olum-aware formatting.

`package.json` sets `configurationDefaults` so the Olum formatter is the
default for HTML files when the extension is active — no manual configuration
needed by users.

### Post-formatter auto-repair (`commands/fixes.ts`)

Even with the custom formatter, a user might run Prettier or another generic
formatter manually. The extension listens to `onDidChangeTextDocument` and runs
a repair pass (debounced 300 ms) after every change:

| Function | What it fixes |
|---|---|
| `caseFixEdits` | `<header>` → `<Header>` (component tag lowercased by formatter) |

It skips `<script>`/`<style>` regions and returns `[]` when there is nothing to
fix, so the edit loop terminates after one pass.

> The earlier `propQuoteFix` / `shorthandFix` repairs were removed with the
> move to quote-delimited syntax: there are no longer any `attr={expr}` or
> `{shorthand}` forms to restore, and unwrapping `attr="{expr}"` would now
> corrupt a legitimate string interpolation.

---

## Go-to-definition on import paths

`language/definitions/definitionProvider.ts` has a special pre-check that runs
**before** the raw-region guard. If the cursor offset falls within the module
specifier string of any import declaration (stored as `specStart`/`specEnd` on
`Declaration` in `scanner/symbols.ts`), it resolves the path and returns the
file location.

This is the only place where `<script>` block content produces a definition
result. Everything else inside `<script>` is ignored.

---

## Where to make common changes

| Task | File(s) |
|---|---|
| **Change a color** | Edit `olum.colors.*` in VS Code settings (changes apply immediately, no recompile). To change defaults, edit `DEFAULTS` in `utils/colors.ts`. |
| **Add a new flow tag** (e.g. `<while>`) | Add the name to `FLOW_TAG_NAMES` in `parser/types.ts`. The parser, highlighter, formatter auto-repair, and auto-close guard all update automatically. Add a snippet too if desired. |
| **Add an auto-importable olum runtime helper** (e.g. `onUnmount`) | Append an entry to `OLUM_RUNTIME` in `language/completion/completionProvider.ts`. Set `snippet` for an expansion (with `$0` as the final cursor), and `importName` when the trigger word differs from the exported name. |
| Recognise a new declaration form for hover/def | `scanner/scriptScope.ts` |
| Adjust how identifiers are extracted from expressions | `parser/expression.ts` |
| Change component file resolution | `components/resolver.ts` — all resolved paths are validated against `vscode.workspace.workspaceFolders` to prevent path-traversal via crafted import specs |
| Add a diagnostic | `diagnostics/diagnostics.ts` |
| Add expression token coloring | `highlighting/exprTokens.ts` + a bucket in `highlighting/decorations.ts`/`highlighter.ts` |
| Change formatter behavior | `language/formatting/formattingProvider.ts` |
| Add a post-formatter repair | `commands/fixes.ts` + wire into `scheduleAutoFix` in `extension.ts` |

---

## Why decorations (not a TextMate grammar)

The same reasons as before: brace- and string-aware tracking for nested
interpolations like `class="a {f({k: v})}"`, whole-expression attribute values,
and multi-line tags cannot be expressed in a stateless TextMate grammar. SCSS
inside `<style>` is still handled by the injected grammar in
`syntax/scss.injection.json`.

---

## Testing the parser without VS Code

The `parser/`, `scanner/`, `components/` and `language/resolve.ts` modules do not
import `vscode`, so they can be exercised directly against the compiled output:

```js
const { parse } = require("./out/parser/documentModel");
const model = parse('<for each="x of list"><span>{x}</span></for>');
console.log(model.forScopes, model.expressions);
```
