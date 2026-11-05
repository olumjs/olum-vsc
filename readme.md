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
| `<card>` where `Card` is imported | Corrected to `<Card>` |

Component names that collide with a real HTML element (`Button`, `Header`,
`Input`, `Form`, …) are deliberately **left alone**. In a file that imports
`Button`, a lowercase `<button>` is far more likely to be the HTML element you
meant to type, and rewriting it would break the page. Nothing about the tag
itself can tell the two apart, so the extension does not guess.

> Note for **Prettier** users: Prettier lowercases any tag whose name matches a
> known HTML element, so `<Button>` becomes `<button>` on every format and has to
> be corrected by hand. The bundled **Olum** formatter does not do this — set
> `"[html]": { "editor.defaultFormatter": "eissapk.olum" }` to avoid it entirely.

---

## Navigation (Ctrl+Click)

| Location | Action |
|---|---|
| Import path — `import Header from "./Header"` | Opens `Header.html` |
| Import path — `import { cart } from "../utils/cart"` | Opens `cart.js` |
| Import path — `import { onMount } from "olum"` | Opens the package's entry file |
| Imported name — the `cart` in that import | Jumps to `export const cart` inside `cart.js` |
| Imported name used in `<script>` — `cartTotal()` | Same — jumps to its `export` |
| Component tag — `<Header />` in template | Opens `Header.html` |
| Imported value in interpolation — `{ArrowRight}` | Jumps to its `export` in the module |
| Variable in interpolation — `<Comp val="{title}" />` | Jumps to `title` declaration |
| Property access — `<Comp val="{r.input}" />` | Jumps to `input:` inside the `r` object |
| Variable in expression attribute — `<button onclick="save(title)">` | Jumps to `title` declaration |
| `<for>` local — `{todo}` inside a loop body | Jumps to the `each="todo of …"` binding |

Specifiers resolve the way Node does: extensionless relative paths pick up
`.js` / `.mjs` / `.ts` / `.html` (and `index.*` inside a directory), and bare
specifiers such as `"olum-icons/lucide"` are looked up through `node_modules`,
honouring the package's `exports` map.

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

`<style>` blocks are excluded from all of the above, and `<script>` is excluded
from template analysis — only imports are followed there, so Ctrl+Click on an
imported name works the way it does in a `.js` file.

---

## Auto-Complete

**Component names** — type `<` to get a dropdown of all components:
- Already-imported components are suggested as-is
- Workspace `.html` files with PascalCase names are suggested with auto-import — selecting one automatically adds `import ComponentName from "./ComponentName"` after your last import line

**Variables in expressions** — type `{` inside a string attribute or text to open an interpolation and get a dropdown of all `const`/`let`/`var`, `function`, and `this.*` identifiers declared in the current file (the same identifiers are available inside expression-attribute values like `onclick="…"`)

**Any module symbol** — inside a `<script>` block, typing a name suggests every
symbol the workspace can export, exactly like auto-import in a `.js` file.
Selecting one inserts the import for you:

| You type | You get | Auto-import |
|---|---|---|
| `cartTot` | `cartTotal` | `import { cartTotal } from "../utils/cart";` |
| `ArrowRig` | `ArrowRight` | `import { ArrowRight } from "olum-icons/lucide";` |
| `onMou` | `onMount` | `import { onMount } from "olum";` |
| `crossf` | `crossfade` | merged into your existing `import { … } from "olum"` |
| `createSt` | `createStore` | `import createStore from "olum-store";` |

Two sources feed the list: every `.js` / `.mjs` / `.ts` file in the workspace
(`node_modules` and build folders excluded), and the packages in your nearest
`package.json` `dependencies` — entered through each package's `exports`
subpaths, so `olum-icons/lucide` is offered separately from `olum-icons`.
Default exports are included. Because a default import binds to whatever name
you write, each one is offered under both the name its module declares and a
name taken from where it lives — `export default function createStore` inside
`store.js` is found by typing either `createStore` or `store`, and both write a
correct import.

Names already in scope are never suggested, and relative paths are written
relative to the file you are editing. The olum runtime exports (`onMount`,
`props`, `params`, `store`, `crossfade`, the router helpers …) arrive through
this same path — they are ordinary package exports and get no special
treatment.

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

## Contributing
Thanks for wanting to help make Olum VS Code Extension better! 💙 Bug fixes, new features, and docs improvements are all welcome.

### Step by step
1. **Fork** the repo and clone your fork:
   ```bash
   git clone https://github.com/<your-username>/olum-vsc.git
   cd olum-vsc
   ```
2. **Make sure you're up to date** with `master`:
   ```bash
   git fetch origin
   git checkout master
   ```
3. **Create your own branch from it:**
   ```bash
   git checkout -b feat/my-awesome-feature
   # or: git checkout -b fix/describe-the-bug
   ```
4. **Install dependencies:**
   ```bash
   npm install
   ```
5. **Make your change.** Source lives in `src/` (TypeScript, compiled to `out/`). See [MAINTENANCE.md](./MAINTENANCE.md) for the architecture. Keep the change focused: one feature or fix per PR.
6. **Run the tests** with `npm test`, and add or update them in `tests/` when behavior changes. To try the extension, run `npm run compile` then `Developer: Reload Window`.
7. **Commit** using a clear message, following the existing style:
   ```
   feat: add a new completion
   fix: describe the bug
   ```
8. **Push** your branch to your fork:
   ```bash
   git push origin feat/my-awesome-feature
   ```
9. **Open a Pull Request** against `master`. Describe what changed, why, and include a screenshot or small example if it's user-facing.

### PR checklist
- [ ] Branched from the latest `master`
- [ ] PR targets `master`
- [ ] One focused change, clear commit messages

Questions or unsure about an idea? Ask in [Discord](https://discord.gg/2zK7tb2Cg9) before you start — we're happy to help.

## Community
- [X](https://x.com/olumjs)
- [Bluesky](https://bsky.app/profile/olumjs.bsky.social)
- [Discord](https://discord.gg/2zK7tb2Cg9)

## Contact
- General: [hello@olumjs.top](mailto:hello@olumjs.top)
- Security: [security@olumjs.top](mailto:security@olumjs.top) — please report vulnerabilities here privately rather than opening a public issue
