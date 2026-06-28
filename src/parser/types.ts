/**
 * Shared parser types.
 *
 * The parser works exclusively with absolute character offsets into the document
 * text. It never imports `vscode`, which keeps it pure and unit-testable. Offset
 * to `vscode.Position`/`Range` conversion happens in the language/highlighting
 * layers via `utils/ranges`.
 */

/**
 * Add new flow tag names here — the parser, highlighter, formatter auto-repair,
 * and auto-close guard all derive from this array automatically.
 */
export const FLOW_TAG_NAMES = ["if", "else-if", "else", "show", "for"] as const;
export type FlowKind = (typeof FLOW_TAG_NAMES)[number];

/** A half-open `[start, end)` offset range into the document text. */
export interface Region {
  start: number;
  end: number;
}

/** Where an expression was found, which changes how it is treated. */
export type ExpressionContext =
  | "attr" // an expression-attr value (`when="…"`) or a `{…}` interpolation in a string attr
  | "text" // a `{expr}` interpolation in element text content
  | "for-each"; // the `each="x of y"` binding of a <for> tag (handled specially)

/**
 * A JavaScript expression occurrence in the template, with parsed identifiers.
 *
 * Expressions come in two flavours:
 *   - **brace-delimited** `{ … }` — text interpolations and `{…}` interpolations
 *     embedded inside a normal string attribute value; `braceStart`/`braceEnd`
 *     point at the braces.
 *   - **quote-delimited** — the whole value of an expression attribute
 *     (`when`/`each`/`key`/`html`/`on*`); there are no braces, so `braceStart`
 *     and `braceEnd` are both `-1` and the surrounding quotes belong to the `Attr`.
 */
export interface Expression {
  context: ExpressionContext;
  /** Offset of the opening `{`, or -1 for a quote-delimited expression attribute. */
  braceStart: number;
  /** Offset of the closing `}`, or -1 when unterminated / quote-delimited. */
  braceEnd: number;
  /** Inner content range (between the braces). */
  innerStart: number;
  innerEnd: number;
  /** Raw inner text. */
  text: string;
  /** Identifier references extracted from the expression. */
  identifiers: ExprIdentifier[];
  /**
   * True when this expression is the value of an `on*` event handler. The
   * editor's built-in HTML grammar already highlights `on*` values as
   * JavaScript, so the highlighter defers to it for plain handlers and only
   * applies olum coloring when the value is an anonymous function.
   */
  isEventHandler?: boolean;
}

/** Role of an identifier segment within an expression. */
export type IdentifierRole =
  | "root" // a bare identifier or the head of a member chain (`foo`, `foo` in `foo.bar`)
  | "member"; // a property segment after a dot (`bar` in `foo.bar`)

/** A single identifier segment located inside an expression. */
export interface ExprIdentifier {
  name: string;
  start: number;
  end: number;
  role: IdentifierRole;
  /** Root identifier of the member chain this segment belongs to. */
  rootName: string;
  /** Immediate parent object name for a member segment (`foo` for `foo.bar`). */
  objectName?: string;
}

/**
 * A parsed attribute on a tag.
 *
 *   - `string`  — a normal attribute whose value is a literal string. It may
 *     still contain embedded `{…}` interpolations, recorded separately as
 *     brace-delimited `Expression`s.
 *   - `expr`    — an expression attribute (`when`/`each`/`key`/`html`/`on*`)
 *     whose entire quoted value is a JavaScript expression. The quotes are kept
 *     in `quoteOpen`/`quoteClose`; the interior is `exprStart`/`exprEnd`.
 *   - `boolean` — a valueless attribute (`disabled`).
 */
export interface Attr {
  kind: "string" | "expr" | "boolean";
  /** Prop name. */
  name: string;
  nameStart: number;
  nameEnd: number;
  /** `=` sign offset (for string/expr attrs). */
  eqOffset?: number;
  /** Quote offsets — set for both `string` and `expr` (quote-delimited) attrs. */
  quoteOpen?: number;
  quoteClose?: number;
  /** Literal string content range (for `string` attrs). */
  strStart?: number;
  strEnd?: number;
  /** Expression interior range (for `expr` attrs). */
  exprStart?: number;
  exprEnd?: number;
}

/** A PascalCase component tag occurrence. */
export interface ComponentTag {
  name: string;
  nameStart: number;
  nameEnd: number;
  isClosing: boolean;
  selfClosing: boolean;
  /** Offset of the `<`. */
  tagStart: number;
  /** Offset just past the closing `>` (or text length if unterminated). */
  tagEnd: number;
  attrs: Attr[];
}

/** A control-flow tag occurrence (`<if>`, `<for>`, …). */
export interface FlowTag {
  kind: FlowKind;
  isClosing: boolean;
  /** Offset of the `<`. */
  ltOffset: number;
  /** Offset of the keyword start (`i` of `if`). */
  keywordStart: number;
  keywordEnd: number;
  /** Offset of the closing `>` (or -1 if not on found). */
  gtOffset: number;
  selfClosing: boolean;
  tagStart: number;
  tagEnd: number;
  attrs: Attr[];
}

/** A local variable introduced by a `<for each={x of y}>` binding. */
export interface ForLocal {
  name: string;
  start: number;
  end: number;
}

/** The lexical scope created by a `<for>` element. */
export interface ForScope {
  locals: ForLocal[];
  /** Offset just after the `<for ...>` opening tag's `>`. */
  bodyStart: number;
  /** Offset of the matching `</for>`'s `<`, or text length if unmatched. */
  bodyEnd: number;
}

/** Result of a raw structural scan (no identifier/scope resolution yet). */
export interface ScanResult {
  components: ComponentTag[];
  flows: FlowTag[];
  expressions: Expression[];
  scriptRegions: Region[];
  styleRegions: Region[];
}

/** Fully parsed template, consumed by every language feature. */
export interface ParsedDocument extends ScanResult {
  /** Document version this parse corresponds to. */
  version: number;
  /** Full document text. */
  text: string;
  forScopes: ForScope[];
  /** Union of script + style inner-content regions, sorted, for fast membership tests. */
  rawRegions: Region[];
}
