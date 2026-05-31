/**
 * JavaScript-like expression parsing for `{ ... }` template expressions.
 *
 * This is a small hand-written lexer, not a full JS parser. Its single job is to
 * extract identifier *references* with precise offsets while correctly ignoring:
 *   - string and template-literal contents
 *   - numeric literals
 *   - language keywords / literals (true, false, null, typeof, …)
 *   - object-literal property *keys* (`{ name: value }` → `name` is not a ref)
 *
 * It understands member chains (`a.b.c` → root `a`, members `b`, `c`) and
 * optional chaining (`a?.b`). Object-key vs ternary-branch disambiguation is done
 * with a per-scope ternary counter, the same technique editors use.
 */

import { ExprIdentifier } from "./types";

/** Reserved words / literals that are never user variable references. */
const RESERVED = new Set([
  "true", "false", "null", "undefined", "this", "new", "typeof", "instanceof",
  "in", "of", "void", "delete", "await", "yield", "function", "class", "return",
  "if", "else", "for", "while", "do", "switch", "case", "break", "continue",
  "var", "let", "const", "NaN", "Infinity",
]);

interface Frame {
  /** Whether this brace frame is an object literal (vs array/paren). */
  isObject: boolean;
  /** Number of unmatched ternary `?` in this frame. */
  ternary: number;
}

const isIdentStart = (c: string): boolean =>
  (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c === "$";

const isIdentPart = (c: string): boolean => isIdentStart(c) || (c >= "0" && c <= "9");

/**
 * Parse an expression body and return every identifier reference it contains.
 * @param text   The expression text (without the wrapping braces).
 * @param base   Absolute document offset of `text[0]`.
 */
export function parseExpression(text: string, base: number): ExprIdentifier[] {
  const out: ExprIdentifier[] = [];
  const stack: Frame[] = [{ isObject: false, ternary: 0 }];
  const top = (): Frame => stack[stack.length - 1];
  const n = text.length;
  let i = 0;

  const skipString = (quote: string): void => {
    i++; // opening quote
    while (i < n) {
      const c = text[i];
      if (c === "\\") { i += 2; continue; }
      if (c === quote) { i++; return; }
      i++;
    }
  };

  const skipTemplate = (): void => {
    i++; // opening backtick
    while (i < n) {
      const c = text[i];
      if (c === "\\") { i += 2; continue; }
      if (c === "`") { i++; return; }
      // We intentionally skip ${...} interpolation contents; identifiers inside
      // template placeholders are uncommon in olum attributes.
      if (c === "$" && text[i + 1] === "{") {
        let depth = 1;
        i += 2;
        while (i < n && depth > 0) {
          if (text[i] === "{") depth++;
          else if (text[i] === "}") depth--;
          i++;
        }
        continue;
      }
      i++;
    }
  };

  /** Read an identifier (and any trailing `.member` / `?.member` chain). */
  const readChain = (): void => {
    const headStart = i;
    while (i < n && isIdentPart(text[i])) i++;
    const headName = text.slice(headStart, i);

    // Is this an object-literal key? `{ name: ... }` with no pending ternary.
    let j = i;
    while (j < n && /\s/.test(text[j])) j++;
    const followedByColon = text[j] === ":";
    if (top().isObject && top().ternary === 0 && followedByColon) {
      return; // property key — not a reference
    }

    const isReserved = RESERVED.has(headName);
    if (!isReserved) {
      out.push({
        name: headName,
        start: base + headStart,
        end: base + i,
        role: "root",
        rootName: headName,
      });
    }

    // Walk a member chain: `.prop` or `?.prop`.
    let objectName = headName;
    for (;;) {
      let k = i;
      while (k < n && /\s/.test(text[k])) k++;
      let dot = -1;
      if (text[k] === ".") dot = k;
      else if (text[k] === "?" && text[k + 1] === ".") dot = k + 1;
      if (dot === -1) break;
      let m = dot + 1;
      while (m < n && /\s/.test(text[m])) m++;
      if (m >= n || !isIdentStart(text[m])) break;
      const segStart = m;
      while (m < n && isIdentPart(text[m])) m++;
      const segName = text.slice(segStart, m);
      if (!isReserved) {
        out.push({
          name: segName,
          start: base + segStart,
          end: base + m,
          role: "member",
          rootName: headName,
          objectName,
        });
      }
      objectName = segName;
      i = m;
    }
  };

  while (i < n) {
    const c = text[i];

    if (c === " " || c === "\t" || c === "\r" || c === "\n") { i++; continue; }
    if (c === '"' || c === "'") { skipString(c); continue; }
    if (c === "`") { skipTemplate(); continue; }

    if (c === "{") { stack.push({ isObject: true, ternary: 0 }); i++; continue; }
    if (c === "[" ) { stack.push({ isObject: false, ternary: 0 }); i++; continue; }
    if (c === "(") { stack.push({ isObject: false, ternary: 0 }); i++; continue; }
    if (c === "}" || c === "]" || c === ")") {
      if (stack.length > 1) stack.pop();
      i++;
      continue;
    }

    if (c === "?") {
      if (text[i + 1] === ".") { i += 2; continue; } // optional chaining handled in readChain
      if (text[i + 1] === "?") { i += 2; continue; } // nullish coalescing
      top().ternary++;
      i++;
      continue;
    }
    if (c === ":") {
      if (top().ternary > 0) top().ternary--;
      i++;
      continue;
    }

    // Number literal (incl. leading dot like .5)
    if ((c >= "0" && c <= "9") || (c === "." && text[i + 1] >= "0" && text[i + 1] <= "9")) {
      i++;
      while (i < n && /[0-9a-fA-FxXbBoO._eE+-]/.test(text[i])) i++;
      continue;
    }

    if (isIdentStart(c)) { readChain(); continue; }

    i++; // operator / punctuation we don't track
  }

  return out;
}

/** Result of parsing a `<for each={ ... }>` binding. */
export interface ForBinding {
  locals: { name: string; start: number; end: number }[];
  /** Identifier references of the iterable (right-hand side). */
  iterable: ExprIdentifier[];
}

/**
 * Parse a `for` binding such as `item of props.todos`, `(item, index) of list`,
 * or `key in obj`. Left side identifiers become locals; the right side is parsed
 * as a normal expression.
 */
export function parseForEach(text: string, base: number): ForBinding {
  const empty: ForBinding = { locals: [], iterable: [] };
  // Find the top-level ` of ` / ` in ` keyword.
  const kw = findForKeyword(text);
  if (!kw) {
    // No keyword: treat the whole thing as locals (best effort).
    return { locals: collectLocals(text, 0, text.length, base), iterable: [] };
  }
  const locals = collectLocals(text, 0, kw.start, base);
  const rhsStart = kw.end;
  const iterable = parseExpression(text.slice(rhsStart), base + rhsStart);
  return locals.length || iterable.length ? { locals, iterable } : empty;
}

/** Locate the top-level `of`/`in` keyword in a for binding. */
function findForKeyword(text: string): { start: number; end: number } | null {
  const n = text.length;
  let depth = 0;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") { depth++; i++; continue; }
    if (c === ")" || c === "]" || c === "}") { depth--; i++; continue; }
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < n && text[i] !== q) { if (text[i] === "\\") i++; i++; }
      i++;
      continue;
    }
    if (depth === 0 && (c === "o" || c === "i")) {
      const word = text.slice(i, i + 2);
      const before = i === 0 ? " " : text[i - 1];
      const after = text[i + 2] ?? " ";
      const boundaryBefore = /\s/.test(before);
      const boundaryAfter = /\s/.test(after);
      if (boundaryBefore && boundaryAfter && (word === "of" || word === "in")) {
        return { start: i, end: i + 2 };
      }
    }
    i++;
  }
  return null;
}

/** Extract comma-separated identifiers from a `(a, b)` or `a` local pattern. */
function collectLocals(
  text: string,
  from: number,
  to: number,
  base: number,
): { name: string; start: number; end: number }[] {
  const locals: { name: string; start: number; end: number }[] = [];
  let i = from;
  while (i < to) {
    const c = text[i];
    if (isIdentStart(c)) {
      const s = i;
      while (i < to && isIdentPart(text[i])) i++;
      locals.push({ name: text.slice(s, i), start: base + s, end: base + i });
      continue;
    }
    i++;
  }
  return locals;
}
