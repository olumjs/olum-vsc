<p align="center"><img width="100" src="https://github.com/olumjs.png" alt="Olum logo"></p>

<h1 align="center">Olumjs</h1>

VS Code extension for the [olumjs](https://github.com/olumjs) framework. Provides syntax highlighting, formatting, navigation, hover info, auto-complete, and diagnostics for `.html` component files.

---

## Snippets

| Snippet | Description              |
|---------|--------------------------|
| `if`    | Create if statement      |
| `elif`  | Create else if statement |
| `else`  | Create else statement    |
| `forin` | Create for in loop       |
| `forof` | Create for of loop       |
| `show`  | Create show statement    |
| `com`   | Create component tag     |

---

## The syntax model

In olum, **everything lives inside `""`**:

- **Expression attributes** hold a JavaScript expression as their *entire* quoted value: `when`, `each`, `key`, `html`, and every `on*` event handler (`onclick`, `oninput`, …).

  ```html
  <if when="state.tab === 'a'">
  <for each="fruit of state.fruits" key="fruit.id">
  <input oninput="(e) => state.text = e.target.value" />
  <div html="state.richHtml"></div>
  ```

- **All other attributes** are literal strings that may contain `{expr}` interpolations for the dynamic parts. Any number of interpolations may appear in one value, and strings nested inside an expression highlight correctly:

  ```html
  <a class="tab {state.tab==='a' ? 'tab-active' : 'tab-inactive'}"
     href="/users/{state.user.id}"
     title="Open {state.user.name}'s profile (id {state.user.id})"
     style="border-color:{state.accentColor}; color:{state.accentColor};">…</a>
  ```

- **Text** between tags is `{expr}`, auto-escaped: `<p>count: {n + 1}</p>`.

---

## Syntax Highlighting

- **Component names** (`<Header />`, `</Header>`) — distinct color for PascalCase tags
- **Flow tags** (`<if>`, `<for>`, `<show>`, `<else-if>`, `<else>`) — keyword and `<`/`>` colored together
- **Prop names** — `title` in `title="foo"`
- **Prop values** — strings, numbers, booleans, null/undefined, variables, operators (`===`, `+`, `.`, `=>`, …) and braces each get their own color
- **Expression attributes** — the whole quoted value of `when`/`each`/`key`/`html`/`on*` is highlighted as a JavaScript expression, e.g. `when="name == 9 ? true : 'foo'"` and `each="item of list"`
- **`on*` event handlers** — the editor's built-in HTML grammar already highlights `on*` values as JavaScript, so olum defers to it for plain handlers (`onclick="save(item)"`) and only applies its own coloring when the value is an anonymous function (`oninput="(e) => state.text = e.target.value"`)
- **Interpolations in string attributes** — only the `{expr}` regions of an ordinary attribute value are highlighted as JavaScript; the surrounding text stays a string
- **Text interpolations** — `{expr}` written in markup text content gets full expression highlighting too (e.g. `<span>{text}</span>`, `<p>count: {n + 1}</p>`)
- **`<for>` locals** — a loop variable introduced by `each="item of list"` is colored distinctly everywhere it is used in the loop, including in the `key` attribute and the loop body
- **SCSS** — syntax highlighting injected inside `<style>` blocks
- **`<script>` / `<style>` are ignored** — olum template highlighting (component/flow tags and `{expr}` interpolations) is skipped inside these blocks, so plain JS and CSS braces are left alone (SCSS is still highlighted by the injected grammar)

---

## Formatting

The extension registers its own HTML formatter (powered by [js-beautify](https://github.com/beautify-web/js-beautify)) that understands olum template syntax, including JavaScript that lives inside attribute quotes (e.g. `when="a == 'b' || c"`).

The Olum formatter is set as the default for HTML files automatically when the extension is active. To set it explicitly in a workspace, add to `.vscode/settings.json`:

```json
"[html]": {
  "editor.defaultFormatter": "eissapk.olum"
}
```

The formatter respects VS Code's existing `html.format.*` settings (indent size, wrap line length, wrap attributes, etc.).

### Formatter auto-repair

After any formatting pass the extension also runs an auto-repair to undo damage that a generic formatter may still cause:

| Damage | Repair |
|--------|--------|
| `<header>` → component tag lowercased | Restored to `<Header>` |

---

## Navigation (Ctrl+Click)

| Location | Action |
|---|---|
| Import path — `import Header from "./Header"` | Opens `Header.html` |
| Component tag — `<Header />` in template | Opens `Header.html` |
| Variable in interpolation — `<Comp val="{title}" />` | Jumps to `title` declaration |
| Property access — `<Comp val="{r.input}" />` | Jumps to `input:` inside the `r` object |
| Variable in expression attribute — `<button onclick="save(title)">` | Jumps to `title` declaration |
| `<for>` local — `{todo}` inside a loop body | Jumps to the `each="todo of …"` binding |

> Ctrl+Click on the **path string** in an import (e.g. `"./Header"`) opens the file. Clicking the imported name (`Header`) itself does nothing — the `<script>` block is not analysed for template navigation.

---

## Hover Tooltips

Hovering over a variable or property inside any expression — a `{expr}` interpolation or an expression attribute (`when`/`each`/`key`/`html`/`on*`) — shows a VS Code-style type tooltip:

```
(const) title: string
(property) input: number
(function) doSomething(a, b): void
(method) onClick(): void
```

Supported for plain variables, object properties (`r.input`), `<for>` locals, and components.

---

## References & Rename

For any symbol used in a template expression — variables, object properties,
`<for>` locals, and component tags:

- **Find All References** (`Shift+F12`) lists every use across the template.
- **Rename Symbol** (`F2`) updates every use plus the declaration (and, for
  components, the import name). `<for>` locals are renamed only within their
  loop body, and same-named outer variables are left untouched.
- **Peek Definition** (`Alt+F12`) works wherever Go To Definition does.

`<script>` and `<style>` blocks are excluded from all of the above — only the
framework template is analysed.

---

## Auto-Complete

**Component names** — type `<` to get a dropdown of all components:
- Already-imported components are suggested as-is
- Workspace `.html` files with PascalCase names are suggested with auto-import — selecting one automatically adds `import ComponentName from "./ComponentName"` after your last import line

**Variables in expressions** — type `{` inside a string attribute or text to open an interpolation and get a dropdown of all `const`/`let`/`var`, `function`, and `this.*` identifiers declared in the current file (the same identifiers are available inside expression-attribute values like `onclick="…"`)

**Olum runtime helpers** — inside a `<script>` block, typing one of the runtime exports suggests a completion that auto-imports it from `"olum"`. Selecting one inserts a ready-to-fill snippet (cursor at `⟨…⟩`) and adds the import — merging into an existing `import { … } from "olum"` line when there is one:

| Type | Inserts | Auto-import |
|------|---------|-------------|
| `onMount` | `onMount(() => { ⟨…⟩ })` | `import { onMount } from "olum";` |
| `props`   | `const {⟨…⟩} = props()`   | `import { props } from "olum";`   |
| `params`  | `const {⟨…⟩} = params()`  | `import { params } from "olum";`  |

---

## Language Configuration

Auto-closing pairs active in `.html` files:

| Type | Pair |
|------|------|
| Interpolations | `{` → `}` |
| Arrays | `[` → `]` |
| Calls | `(` → `)` |
| Strings | `"` → `"` · `'` → `'` |

Surrounding pairs: select any text and type `{`, `[`, `(`, `"`, or `'` to wrap it.

---

## Diagnostics

Squiggly warnings are shown for:

- **Unimported component** — a PascalCase tag is used in the template but has no matching `import` statement
- **Duplicate prop** — the same prop name appears more than once on a component tag

```html
<Header title="foo" title="bar" />
<!--              ^^^^^ Duplicate prop 'title' -->
```

---

## Security

- **No network calls** — the extension never transmits data outside your machine.
- **No code execution** — document text is parsed but never evaluated.
- **Workspace-sandboxed file resolution** — import specifiers like `../../.ssh/id_rsa` are rejected before any filesystem access. Go-to-definition only resolves paths that fall inside the open workspace folders.
