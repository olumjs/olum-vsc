# Olum VS Code Extension — Maintenance Guide

## What this extension does

The [olum](https://github.com/olumjs/olum-vsc) framework uses HTML files with a
custom template syntax: component tags that start with an uppercase letter
(`<MyComponent />`), and control-flow tags (`<if>`, `<for>`, `<else>`, `<show>`).
These are not valid HTML, so VS Code's built-in HTML tokenizer gives them no
special color.

This extension adds two features on top of plain HTML files:

1. **Syntax highlighting** — paints component names, flow keywords, prop names,
   and prop values with distinct colors using VS Code's decoration API.
2. **Code snippets** — short prefixes (`olum`, `olumc`, `if`, `for`, …) that
   expand into common olum boilerplate.

---

## What the olum template syntax looks like

```html
<!-- Flow control tags -->
<if cond="user.isAdmin">
  <AdminPanel />
</if>
<else>
  <GuestView />
</else>

<for cond="item of list">
  <ListItem name={item.name} active={true} count={42} />
</for>

<!-- Component with various prop value types -->
<MyComp
  label="hello"
  count={42}
  visible={true}
  data={null}
  user={currentUser}
  info={{name:"eissa", age:20}}
  {shorthand}
  mkd={flag ? "yes" : "no"}
/>
```

The highlighter colors each part differently:
- `MyComp`, `AdminPanel` — component name color
- `if`, `for`, `else` — flow keyword color
- `label`, `count`, `visible` — prop name color
- `"hello"` — string color
- `42` — number color
- `true` — boolean color
- `null` — null/undefined color
- `currentUser` — variable color
- `{` `}` outer wrappers — gold brace color
- `{ }` `[ ]` inside an expression — prop-name color (purple)

---

## File responsibilities and data flow

### Responsibility of each file

```
bin/index.js
  │  The only file VS Code calls directly (via "main" in package.json).
  │  Owns the extension lifecycle: activate / deactivate.
  │  Knows about: highlight.js, colors.js
  │
  ├── lib/colors.js
  │     Static color definitions. No logic, no imports.
  │     Read once on activation. Edit here to change any color.
  │
  ├── lib/highlight.js
  │     Knows how to scan a full document and apply decorations.
  │     Owns: decoration types (DEC), the per-line loop, inComp state.
  │     Knows about: getRange.js, helpers.js
  │
  │     ├── lib/getRange.js
  │     │     Knows how to turn a line string into vscode.Range objects.
  │     │     Has no knowledge of the editor or decorations.
  │     │     Owns: scanPropNames, scanPropVals, tokenizeExpr, getPropValRanges
  │     │     Knows about: helpers.js (isUpper only)
  │     │
  │     └── lib/helpers.js
  │           Pure predicates. No VS Code API calls except inside isHTML.
  │           Knows about: nothing
  │
  └── snippets/snippets.code-snippets
        Declarative JSON. Loaded by VS Code directly from package.json.
        Completely independent — no connection to the highlighter at all.
```

### What calls what on every keystroke

```
User types a character
  │
  ▼
VS Code fires onDidChangeTextDocument
  │
  ▼
bin/index.js  ──registered──►  highlight()          [lib/highlight.js]
                                    │
                                    │  gets active editor, splits into lines
                                    │  loops over every line
                                    │
                                    ├── RE_COMP_HAS.test(line)
                                    │     if true (single-line component):
                                    │       line.matchAll(RE_COMP_OPEN)   → comp name ranges
                                    │       line.matchAll(RE_COMP_CLOSE)  → closing name ranges
                                    │       getRange(line, index, "prop") → prop name ranges
                                    │       getPropValRanges(line, index) → all value ranges
                                    │
                                    ├── RE_ML_START.exec(line)
                                    │     if matched (multi-line opener):
                                    │       scanPropNames(ml[3], …)       → prop name ranges
                                    │       scanPropVals(ml[3], …)        → value ranges
                                    │       sets inComp = true
                                    │
                                    ├── inComp continuation lines:
                                    │       scanPropNames(attrsLine, …)   → prop name ranges
                                    │       scanPropVals(attrsLine, …)    → value ranges
                                    │
                                    └── FLOW_TAGS loop (every line):
                                          openRe.exec(line)  → flow keyword range
                                          closeRe.exec(line) → flow keyword range
                                    │
                                    ▼
                              editor.setDecorations(DEC.*, ranges[])
                                    │  called 11 times, once per color
                                    ▼
                              Colors appear in editor
```

### What calls what inside `getRange.js`

```
getRange(line, index, "prop")
  └── scanPropNames(attrsStr, lineIndex, attrOffset)
        regex walk over attrs string → prop key Ranges

getPropValRanges(line, index)              ← called for single-line tags
  └── scanPropVals(attrsStr, lineIndex, attrOffset)
        linear walk over attrs string
          ├── ="…"  path  → strQuote + str ranges directly
          ├── ={…}  path  → brace ranges + tokenizeExpr(content, …)
          │     └── tokenizeExpr
          │           character walk → str / num / keyword / nullish / varr / propName ranges
          └── {x}   path  → brace + varr ranges directly

scanPropVals(attrsStr, lineIndex, attrOffset)   ← also called directly for multi-line
  └── (same as above)
```

---

## Why decorations, not a TextMate grammar

VS Code extensions can highlight code in two ways:

| Approach | How it works | Limitation |
|---|---|---|
| TextMate grammar (`.tmLanguage.json`) | Regex-based scope rules; VS Code tokenizes automatically | Stateless — can't track multi-line tags; no brace-depth matching |
| Decoration API (this extension) | JavaScript runs on every keystroke; computes `Range` objects and paints them | Must re-scan the whole document on every change |

This extension needs brace-depth tracking (for `={nested: {objects}}`) and
multi-line component state (for props spread across multiple lines), which
TextMate grammars cannot express. The decoration API makes both straightforward.

---

## File map

```
bin/index.js              Entry point — wires VS Code events to the highlighter
lib/colors.js             ALL colors in one place — edit here to change any color
lib/highlight.js          Main loop — iterates lines, applies decorations
lib/getRange.js           All range computation — tag names, props, expressions
lib/helpers.js            Tiny predicates (isHTML, isFullArr, isUpper, …)
snippets/snippets.code-snippets   Code snippet definitions (independent of highlighter)
syntax/scss.injection.json        TextMate grammar that enables SCSS inside HTML <style>
```

### Dead files (not imported anywhere — kept for reference only)

```
lib/regex.js              Old regex constants — superseded by inline patterns in highlight.js
lib/themeLoader.js        Old dynamic theme reader — removed when theme-following was disabled
```

These two files have no effect. They can be safely deleted. They are kept only
as a reference in case theme-following is ever re-enabled.

---

## Development setup

No build step. The extension runs directly from source.

**To see changes after editing a file:**
```
Ctrl+Shift+P → Developer: Reload Window
```

**To check a file for syntax errors without loading VS Code:**
```bash
node --check lib/getRange.js
node --check lib/highlight.js
```

---

## Changing a color

Open `lib/colors.js` and edit the hex value, then reload.

```js
brace: "#ffd700",   // ← change this
```

The active editor theme is **intentionally ignored**. `colors.js` is the only
source of truth. This is by design — it prevents the theme from silently
overriding values you set here. Do not re-introduce `themeLoader.js` without
understanding this decision.

---

## Adding a new flow tag (e.g. `<while>`)

Two places need a new entry:

**1. `lib/highlight.js` — `FLOW_TAGS` array**

```js
{ openRe: /<while(?=[\s>\/])/, closeRe: /<\/while>/, len: 5 },
```

- `openRe` — matches the opening tag. The lookahead `(?=[\s>\/])` prevents
  false positives on longer tag names (e.g. `<whileTrue>`).
- `closeRe` — matches the closing tag.
- `len` — number of characters in the keyword (`"while".length === 5`).

**2. `lib/getRange.js` — `META` table inside `getRange()`**

```js
"while": { len: 5, openRe: /<while(?=[\s>\/])/, closeRe: /<\/while>/ },
```

That is all — no other files need changing.

---

## Adding a new decoration color end-to-end

**1. `lib/colors.js`** — add the key and a hex value:
```js
regexpVal: "#c3f0ca",
```

**2. `lib/highlight.js` — inside `createDecorations()`:**
```js
regexp: T(c.regexpVal),
```

**3. `lib/highlight.js` — inside `highlight()`:**
```js
const charsRegexp = [];
// … fill it …
editor.setDecorations(DEC.regexp, charsRegexp);
```

**4. `lib/getRange.js` — produce ranges** inside `tokenizeExpr()` or
`scanPropVals()` and push them to a matching `out` / accumulator field.

If the new type appears inside a `={...}` expression, add it to the `out`
object passed to `tokenizeExpr` and add an `if` branch inside `tokenizeExpr`
that detects and pushes to `out.regexp`.

---

## Understanding `getRange.js`

This file does all the math: given a line of text and a line index, return
`vscode.Range` objects for the characters that need color.

### `scanPropNames(attrsStr, lineIndex, attrOffset)`

Finds every `propName=` occurrence in an attrs substring.
`attrOffset` is the column in the full line where `attrsStr` starts.

### `scanPropVals(attrsStr, lineIndex, attrOffset)` — single linear walk

Rather than running six separate regex passes, this function walks the attrs
string once, character by character:

```
ch === '=' and next is '"' or "'   →  string value path
ch === '=' and next is '{'         →  brace-depth walk + tokenizeExpr
ch === '{' and prev is not '='     →  {shorthand} path
everything else                    →  advance i++
```

The `={...}` path uses a brace-depth counter so nested structures like
`={{a:1}}` and `={[1,2,3]}` are parsed correctly without special-casing
each value type.

### `tokenizeExpr(content, lineIndex, baseOffset, out)`

Walks the content between `={` and `}` token by token. Priority order:

```
whitespace        → skip
" or '            → string literal (respects \ escape sequences)
{ } [ ]           → propName color (inner braces — purple, distinct from gold outer)
? : ,             → nullish color
/[a-zA-Z_$]/      → identifier → true/false → boolVal
                                  null/undefined → nullVal
                                  anything else  → varVal
digit or -digit   → number
anything else     → skip
```

⚠️ **Critical:** Use `/[a-zA-Z_$]/` and `/[a-zA-Z0-9_.]/` regex classes for
identifier detection. Raw char-code comparisons like `charCode >= 48`
accidentally include `:` (code 58) and cause `true:` in a ternary to be
consumed as one token instead of two.

---

## Understanding `highlight.js`

### Decoration lifecycle

`createDecorations(colors)` builds one `TextEditorDecorationType` per color.
These objects are expensive — they are created once on activation and reused.
If colors need to change, `createDecorations` disposes the old types and builds
new ones.

`highlight()` is called on every keystroke. It re-scans the whole document,
builds Range arrays, and calls `editor.setDecorations()` once per type.

### Multi-line component state (`inComp`)

```
<MyComp             ← RE_ML_START matches → inComp = true
  propA="val"       ← continuation: scan props only (no name coloring)
  propB={42}        ← continuation
/>                  ← closesTag → inComp = false
```

`inComp` is a local variable reset to `false` at the top of each `highlight()`
call. Stale state never carries over between renders.

### Decoration ordering

When two decoration types cover the same character, the **last**
`setDecorations` call wins. Current order:

```
comp → flow → propName → propEq → strQuote → str → brace → num → kw → nullish → varVal
```

Move a `setDecorations` call later in the list if it needs to override another.

---

## Understanding the snippets (`snippets/snippets.code-snippets`)

Snippets are completely independent of the highlighter — they are a separate
VS Code feature registered in `package.json` under `contributes.snippets`.

Each entry has:
- `prefix` — what the user types to trigger the snippet
- `body` — the inserted text (`${1}` is the first tab stop, `$0` is final cursor)
- `description` — shown in the autocomplete tooltip

To add a new snippet, add a JSON entry to `snippets.code-snippets`. No JS
changes needed.

---

## Common pitfalls

| Symptom | Likely cause |
|---|---|
| Color change in `colors.js` has no effect | Reload window (`Ctrl+Shift+P → Developer: Reload Window`) |
| New flow tag not highlighted | Missing entry in `FLOW_TAGS` (highlight.js) **and** `META` table (getRange.js) |
| `true:` colored as a variable | Identifier scan using char-code `>= 48` — `:` (58) gets included; use regex classes |
| Decoration flashes then disappears | `setDecorations` called before `createDecorations` (`DEC` is null); check `if (!DEC) return` guard |
| Wrong column positions on props | `attrOffset` miscalculated — must be `tagMatch.index + 1 + tagName.length` |
| Multi-line component props not highlighted | `RE_ML_START` didn't match — check the line starts with optional whitespace then `<UppercaseName` |
| Object value `={{...}}` shows wrong colors | `tokenizeExpr` is not receiving `propName` in its `out` argument — inner `{}` need it to be colored purple |
| `lib/regex.js` or `lib/themeLoader.js` changes have no effect | These files are not imported anywhere — they are dead code |
