<p align="center"><img width="100" src="https://github.com/olumjs.png" alt="Olum logo"></p>

<h1 align="center">Olumjs</h1>

VS Code extension for the [olumjs](https://github.com/olumjs) framework. Provides syntax highlighting, navigation, hover info, auto-complete, and diagnostics for `.html` component files.

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

## Syntax Highlighting

- **Component names** (`<Header />`, `</Header>`) — distinct color for PascalCase tags
- **Flow tags** (`<if>`, `<for>`, `<show>`, `<else-if>`, `<else>`) — keyword and `<`/`>` colored together
- **Prop names** — `title` in `title="foo"` or `title={expr}`
- **Prop values** — strings, numbers, booleans, null/undefined, variables, and braces each get their own color
- **Expressions inside flow attributes** — full expression highlighting inside `when={}` (on `<if>`, `<else-if>`, `<show>`) and `each={}` (on `<for>`), e.g. `<if when={name == 9 ? true : 'foo'}>` and `<for each={item of list}>`
- **Text interpolations** — `{expr}` written in markup text content gets full expression highlighting too (e.g. `<span>{text}</span>`, `<p>count: {n + 1}</p>`)
- **SCSS** — syntax highlighting injected inside `<style>` blocks
- **`<script>` / `<style>` are ignored** — olum template highlighting (component/flow tags and `{expr}` interpolations) is skipped inside these blocks, so plain JS and CSS braces are left alone (SCSS is still highlighted by the injected grammar)

---

## Navigation (Ctrl+Click)

| Location | Action |
|---|---|
| Import path — `import Header from "./Header"` | Opens `Header.html` |
| Component tag — `<Header />` in template | Opens `Header.html` |
| Variable in prop — `<Comp val={title} />` | Jumps to `title` declaration |
| Property access — `<Comp val={r.input} />` | Jumps to `input:` inside the `r` object |
| Shorthand prop — `<Comp {title} />` | Jumps to `title` declaration |

> Clicking the component name in an import line (e.g. `Header` in `import Header from …`) does nothing — use Ctrl+Click on the path string instead.

---

## Hover Tooltips

Hovering over a variable or property inside `{}` shows a VS Code-style type tooltip:

```
(const) title: string
(property) input: number
(function) doSomething(a, b): void
(method) onClick(): void
```

Supported for plain variables, object properties (`r.input`), shorthand props (`{title}`), `<for>` locals, and components.

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

**Variables inside `{}`** — type `{` inside a prop value to get a dropdown of all `const`/`let`/`var`, `function`, and `this.*` identifiers declared in the current file

---

## Language Configuration

Auto-closing pairs active in `.html` files:

| Type | Pair |
|------|------|
| Prop expressions | `{` → `}` |
| Arrays | `[` → `]` |
| Calls | `(` → `)` |
| Strings | `"` → `"` · `'` → `'` |

Surrounding pairs: select any text and type `{`, `[`, `(`, `"`, or `'` to wrap it.

---

## Diagnostics

Squiggly warnings are shown for:

- **Unimported component** — a PascalCase tag is used in the template but has no matching `import` statement
- **Duplicate prop** — the same prop name appears more than once on a component tag (including shorthand `{name}` vs `name=` conflicts)

```html
<Header title="foo" title="bar" />
<!--              ^^^^^ Duplicate prop 'title' -->

<Card {user} user={data} />
<!--         ^^^^ Duplicate prop 'user' -->
```
