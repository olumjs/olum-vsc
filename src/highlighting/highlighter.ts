/**
 * Decoration-based highlighter, driven entirely by the shared `ParsedDocument`.
 *
 * Because the model is offset-based and already understands multi-line tags,
 * multi-line expressions and `<script>`/`<style>` exclusion, this layer is a
 * straightforward mapping from parsed nodes to colored ranges — no per-line
 * state machine, which is what made the previous implementation fragile.
 */

import * as vscode from "vscode";
import { anyForScopeDeclares } from "../parser/documentModel";
import { Attr, ParsedDocument } from "../parser/types";
import { rangeFromOffsets } from "../utils/ranges";
import { Bucket, DecorationSet } from "./decorations";
import { tokenize, TokenKind } from "./exprTokens";

interface OffsetRange { start: number; end: number; }
type Buckets = Record<Bucket, OffsetRange[]>;

const TOKEN_BUCKET: Record<TokenKind, Bucket> = {
  quote: "strQuote",
  string: "str",
  number: "num",
  bool: "kw",
  nullish: "nullish",
  punct: "nullish",
  keywordDecl: "propName",
  keywordFlow: "nullish",
  innerBrace: "propName",
  ident: "varVal",
};

export function highlight(editor: vscode.TextEditor, model: ParsedDocument, dec: DecorationSet): void {
  const b = emptyBuckets();

  // ── component tags ─────────────────────────────────────────────────────────
  for (const tag of model.components) {
    b.comp.push({ start: tag.nameStart, end: tag.nameEnd });
    if (!tag.isClosing) highlightAttrs(tag.attrs, b);
  }

  // ── flow tags ──────────────────────────────────────────────────────────────
  for (const flow of model.flows) {
    b.flow.push({ start: flow.ltOffset, end: flow.ltOffset + 1 }); // <
    b.flow.push({ start: flow.keywordStart, end: flow.keywordEnd }); // keyword
    if (flow.gtOffset !== -1) b.flow.push({ start: flow.gtOffset, end: flow.gtOffset + 1 }); // >
    if (!flow.isClosing) highlightAttrs(flow.attrs, b);
  }

  // ── all {expression} occurrences (attr values, text, for-each) ─────────────
  for (const expr of model.expressions) {
    b.brace.push({ start: expr.braceStart, end: expr.braceStart + 1 });
    if (expr.braceEnd !== -1) b.brace.push({ start: expr.braceEnd, end: expr.braceEnd + 1 });
    for (const tok of tokenize(expr.text, expr.innerStart)) {
      if (tok.kind === "ident") {
        const name = model.text.slice(tok.start, tok.end);
        const bucket: Bucket = anyForScopeDeclares(model, tok.start, name) ? "forLocal" : "varVal";
        b[bucket].push({ start: tok.start, end: tok.end });
      } else {
        b[TOKEN_BUCKET[tok.kind]].push({ start: tok.start, end: tok.end });
      }
    }
  }

  // ── <for> local declarations (override to forLocal color) ──────────────────
  for (const scope of model.forScopes) {
    for (const local of scope.locals) b.forLocal.push({ start: local.start, end: local.end });
  }

  applyBuckets(editor, dec, b);
}

function highlightAttrs(attrs: Attr[], b: Buckets): void {
  for (const attr of attrs) {
    if (attr.kind !== "shorthand") {
      b.propName.push({ start: attr.nameStart, end: attr.nameEnd });
    }
    if (attr.eqOffset !== undefined) b.propEq.push({ start: attr.eqOffset, end: attr.eqOffset + 1 });
    if (attr.kind === "string") {
      if (attr.quoteOpen !== undefined) b.strQuote.push({ start: attr.quoteOpen, end: attr.quoteOpen + 1 });
      if (attr.strStart !== undefined && attr.strEnd !== undefined && attr.strEnd > attr.strStart) {
        b.str.push({ start: attr.strStart, end: attr.strEnd });
      }
      if (attr.quoteClose !== undefined) b.strQuote.push({ start: attr.quoteClose, end: attr.quoteClose + 1 });
    }
    // expr / shorthand brace + content handled by the expressions loop.
  }
}

function emptyBuckets(): Buckets {
  return {
    comp: [], flow: [], propName: [], propEq: [], strQuote: [], str: [],
    brace: [], num: [], kw: [], nullish: [], varVal: [], forLocal: [],
  };
}

// Order matters: later setDecorations wins on overlaps.
const APPLY_ORDER: Bucket[] = [
  "comp", "flow", "propName", "propEq", "strQuote", "str",
  "brace", "num", "kw", "nullish", "varVal", "forLocal",
];

function applyBuckets(editor: vscode.TextEditor, dec: DecorationSet, b: Buckets): void {
  for (const bucket of APPLY_ORDER) {
    const ranges = b[bucket].map((r) => rangeFromOffsets(editor.document, r.start, r.end));
    editor.setDecorations(dec[bucket], ranges);
  }
}
