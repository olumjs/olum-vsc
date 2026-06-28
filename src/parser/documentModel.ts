/**
 * Document model: the single source of truth shared by every language feature.
 *
 * Responsibilities:
 *   - run the structural `scan`
 *   - extract identifier references from each expression
 *   - resolve `<for>` bindings into lexical scopes (local + iterable)
 *   - cache the result per document, keyed by version, so a parse happens at
 *     most once per edit no matter how many providers ask for it
 *
 * Providers call `getModel(document)`; the highlighter, hover, definition,
 * references, rename, completion and diagnostics layers all consume the same
 * `ParsedDocument`.
 */

import type * as vscode from "vscode";
import { parseExpression, parseForEach } from "./expression";
import { scan } from "./scanner";
import { Expression, ForScope, ParsedDocument, Region } from "./types";

interface DocLike {
  uri: { toString(): string };
  version: number;
  getText(): string;
}

const cache = new Map<string, ParsedDocument>();

/** Parse `document`, returning a cached result when the version is unchanged. */
export function getModel(document: DocLike): ParsedDocument {
  const key = document.uri.toString();
  const cached = cache.get(key);
  if (cached && cached.version === document.version) return cached;
  const parsed = parse(document.getText(), document.version);
  cache.set(key, parsed);
  return parsed;
}

/** Drop a document from the cache (call on close). */
export function invalidate(document: vscode.TextDocument): void {
  cache.delete(document.uri.toString());
}

/** Parse raw text into a `ParsedDocument`. Exposed for testing. */
export function parse(text: string, version = 0): ParsedDocument {
  const result = scan(text);
  const forScopes: ForScope[] = [];

  // Index expressions by their inner-content start offset for quick lookup.
  // (Brace offsets are unsuitable now that expression attributes are
  // quote-delimited and share a sentinel `braceStart` of -1.)
  const exprByInner = new Map<number, Expression>();
  for (const e of result.expressions) exprByInner.set(e.innerStart, e);

  // ── resolve <for> scopes and their each-bindings ──────────────────────────
  const stack: ForScope[] = [];
  for (const flow of result.flows) {
    if (flow.kind !== "for") continue;
    if (flow.isClosing) {
      const scope = stack.pop();
      if (scope) scope.bodyEnd = flow.ltOffset;
      continue;
    }
    const eachAttr = flow.attrs.find((a) => a.name === "each" && a.kind === "expr");
    let locals: ForScope["locals"] = [];
    if (eachAttr && eachAttr.exprStart !== undefined && eachAttr.exprEnd !== undefined) {
      const inner = text.slice(eachAttr.exprStart, eachAttr.exprEnd);
      const binding = parseForEach(inner, eachAttr.exprStart);
      locals = binding.locals;
      const expr = exprByInner.get(eachAttr.exprStart);
      if (expr) {
        expr.context = "for-each";
        expr.identifiers = binding.iterable; // only the iterable side are references
      }
    }
    const scope: ForScope = {
      locals,
      // Scope starts at the `<` so the opening tag's own bindings (`each`'s
      // locals, `key="item.id"`, …) resolve against the loop locals too.
      bodyStart: flow.tagStart,
      bodyEnd: text.length,
    };
    if (!flow.selfClosing) stack.push(scope);
    forScopes.push(scope);
  }

  // ── extract identifiers for every remaining expression ─────────────────────
  for (const e of result.expressions) {
    if (e.context === "for-each") continue; // already handled above
    e.identifiers = parseExpression(e.text, e.innerStart);
  }

  const rawRegions = mergeRegions([...result.scriptRegions, ...result.styleRegions]);

  return { ...result, version, text, forScopes, rawRegions };
}

/** Merge and sort regions by start offset. */
function mergeRegions(regions: Region[]): Region[] {
  return regions.slice().sort((a, b) => a.start - b.start);
}

/** True when `offset` falls inside a `<script>` or `<style>` body. */
export function isInRawRegion(model: ParsedDocument, offset: number): boolean {
  for (const r of model.rawRegions) {
    if (offset < r.start) return false; // regions are sorted
    if (offset >= r.start && offset < r.end) return true;
  }
  return false;
}

/** True when any enclosing `<for>` scope at `offset` declares `name`. */
export function anyForScopeDeclares(model: ParsedDocument, offset: number, name: string): boolean {
  for (const s of model.forScopes) {
    if (offset >= s.bodyStart && offset < s.bodyEnd && s.locals.some((l) => l.name === name)) {
      return true;
    }
  }
  return false;
}

/** Find the innermost `<for>` scope whose body contains `offset`. */
export function forScopeAt(model: ParsedDocument, offset: number): ForScope | null {
  let best: ForScope | null = null;
  for (const s of model.forScopes) {
    if (offset >= s.bodyStart && offset < s.bodyEnd) {
      if (!best || s.bodyStart > best.bodyStart) best = s;
    }
  }
  return best;
}

/** Find the expression whose inner range contains `offset`, if any. */
export function expressionAt(model: ParsedDocument, offset: number): Expression | null {
  for (const e of model.expressions) {
    if (offset >= e.innerStart && offset <= e.innerEnd) return e;
  }
  return null;
}
