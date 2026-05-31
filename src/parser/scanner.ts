/**
 * Structural HTML scanner for olum templates.
 *
 * A single linear pass over the whole document (by offset, not by line) that:
 *   - records `<script>` / `<style>` inner-content regions and skips their bodies
 *   - recognises PascalCase component tags and their attributes
 *   - recognises control-flow tags (`<if>`, `<for>`, `<else>`, `<else-if>`, `<show>`)
 *   - records every `{ ... }` expression in attribute values and in text content
 *
 * Because it works on absolute offsets, multi-line tags and multi-line
 * expressions need no special "carry state across lines" handling — they are
 * just longer offset ranges. This removes the most fragile part of the old
 * line-by-line highlighter.
 *
 * Identifier extraction and `<for>` scope resolution are layered on top in
 * `documentModel`, keeping this module purely structural.
 */

import {
  Attr,
  ComponentTag,
  Expression,
  FlowKind,
  FLOW_TAG_NAMES,
  FlowTag,
  Region,
  ScanResult,
} from "./types";

const isUpper = (c: string): boolean => c >= "A" && c <= "Z";
const isTagNameChar = (c: string): boolean => !!c && !/[\s>/]/.test(c);
const isSpace = (c: string): boolean => c === " " || c === "\t" || c === "\r" || c === "\n";
const isAttrNameChar = (c: string): boolean => /[A-Za-z0-9_$:.-]/.test(c);

export function scan(text: string): ScanResult {
  const components: ComponentTag[] = [];
  const flows: FlowTag[] = [];
  const expressions: Expression[] = [];
  const scriptRegions: Region[] = [];
  const styleRegions: Region[] = [];

  const n = text.length;
  let i = 0;

  while (i < n) {
    const c = text[i];

    if (c === "<") {
      // ── HTML comment ──────────────────────────────────────────────────────
      if (text.startsWith("<!--", i)) {
        const end = text.indexOf("-->", i + 4);
        i = end === -1 ? n : end + 3;
        continue;
      }
      // ── doctype / declaration ─────────────────────────────────────────────
      if (text[i + 1] === "!") {
        const end = text.indexOf(">", i + 2);
        i = end === -1 ? n : end + 1;
        continue;
      }

      // ── raw blocks: <script> / <style> ────────────────────────────────────
      const raw = matchRawTag(text, i);
      if (raw) {
        const openEnd = findTagEnd(text, i); // offset of '>' of the opening tag
        if (openEnd === -1) { i = n; continue; }
        const selfClose = text[openEnd - 1] === "/";
        if (selfClose) { i = openEnd + 1; continue; }
        const closeRe = raw === "script" ? /<\/script\s*>/i : /<\/style\s*>/i;
        closeRe.lastIndex = openEnd + 1;
        const m = closeRe.exec(text.slice(openEnd + 1));
        const contentStart = openEnd + 1;
        if (!m) {
          (raw === "script" ? scriptRegions : styleRegions).push({ start: contentStart, end: n });
          i = n;
          continue;
        }
        const contentEnd = openEnd + 1 + m.index;
        (raw === "script" ? scriptRegions : styleRegions).push({ start: contentStart, end: contentEnd });
        i = openEnd + 1 + m.index + m[0].length;
        continue;
      }

      // ── closing tag </name> ───────────────────────────────────────────────
      if (text[i + 1] === "/") {
        const nameStart = i + 2;
        let j = nameStart;
        while (j < n && isTagNameChar(text[j])) j++;
        const name = text.slice(nameStart, j);
        const gt = text.indexOf(">", j);
        const tagEnd = gt === -1 ? n : gt + 1;
        const flow = asFlowKind(name);
        if (flow) {
          flows.push({
            kind: flow, isClosing: true, ltOffset: i,
            keywordStart: nameStart, keywordEnd: nameStart + name.length,
            gtOffset: gt, selfClosing: false, tagStart: i, tagEnd, attrs: [],
          });
        } else if (name && isUpper(name[0])) {
          components.push({
            name, nameStart, nameEnd: nameStart + name.length,
            isClosing: true, selfClosing: false, tagStart: i, tagEnd, attrs: [],
          });
        }
        i = tagEnd;
        continue;
      }

      // ── opening tag <name ...> ────────────────────────────────────────────
      const nameStart = i + 1;
      if (nameStart >= n || !/[A-Za-z]/.test(text[nameStart])) { i++; continue; }
      let j = nameStart;
      while (j < n && isTagNameChar(text[j])) j++;
      const name = text.slice(nameStart, j);

      const tagEnd = findTagEnd(text, i);
      const realEnd = tagEnd === -1 ? n : tagEnd; // offset of '>' or n
      const selfClosing = tagEnd !== -1 && text[tagEnd - 1] === "/";
      const attrsEnd = selfClosing ? tagEnd - 1 : realEnd;
      const attrs = scanAttributes(text, j, attrsEnd, expressions);

      const flow = asFlowKind(name);
      if (flow) {
        flows.push({
          kind: flow, isClosing: false, ltOffset: i,
          keywordStart: nameStart, keywordEnd: nameStart + name.length,
          gtOffset: tagEnd === -1 ? -1 : tagEnd, selfClosing,
          tagStart: i, tagEnd: tagEnd === -1 ? n : tagEnd + 1, attrs,
        });
      } else if (isUpper(name[0])) {
        components.push({
          name, nameStart, nameEnd: nameStart + name.length,
          isClosing: false, selfClosing,
          tagStart: i, tagEnd: tagEnd === -1 ? n : tagEnd + 1, attrs,
        });
      }
      // (plain lowercase HTML tags contribute only their attribute expressions,
      //  which scanAttributes already pushed into `expressions`.)

      i = tagEnd === -1 ? n : tagEnd + 1;
      continue;
    }

    if (c === "{") {
      // Text-content interpolation `{expr}` (we only reach here outside tags).
      const close = matchBrace(text, i);
      const braceEnd = close === -1 ? -1 : close;
      const innerEnd = close === -1 ? n : close;
      expressions.push({
        context: "text",
        braceStart: i,
        braceEnd,
        innerStart: i + 1,
        innerEnd,
        text: text.slice(i + 1, innerEnd),
        identifiers: [],
      });
      i = close === -1 ? n : close + 1;
      continue;
    }

    i++;
  }

  return { components, flows, expressions, scriptRegions, styleRegions };
}

/** Map a tag name to a flow kind, respecting exact matches only. */
function asFlowKind(name: string): FlowKind | null {
  for (const kw of FLOW_TAG_NAMES) {
    if (name === kw) return kw;
  }
  return null;
}

/** Detect `<script`/`<style` at offset `i` with a proper boundary char. */
function matchRawTag(text: string, i: number): "script" | "style" | null {
  const rest = text.slice(i + 1, i + 8).toLowerCase();
  if (/^script(?=[\s>/]|$)/.test(rest)) return "script";
  if (/^style(?=[\s>/]|$)/.test(rest)) return "style";
  return null;
}

/**
 * Find the offset of the `>` that closes the tag starting at `i` (`text[i]`==='<'),
 * being brace- and string-aware so a `>` inside `={() => ...}` is not mistaken
 * for the tag end. Returns -1 if the tag is not closed before EOF.
 */
function findTagEnd(text: string, i: number): number {
  const n = text.length;
  let j = i + 1;
  let depth = 0;
  let inStr: string | null = null;
  while (j < n) {
    const c = text[j];
    if (inStr) {
      if (c === "\\") { j += 2; continue; }
      if (c === inStr) inStr = null;
      j++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inStr = c; j++; continue; }
    if (c === "{") { depth++; j++; continue; }
    if (c === "}") { if (depth > 0) depth--; j++; continue; }
    if (c === ">" && depth === 0) return j;
    j++;
  }
  return -1;
}

/** Find the matching `}` for an opening `{` at offset `i`, string-aware. */
function matchBrace(text: string, i: number): number {
  const n = text.length;
  let depth = 0;
  let j = i;
  let inStr: string | null = null;
  while (j < n) {
    const c = text[j];
    if (inStr) {
      if (c === "\\") { j += 2; continue; }
      if (c === inStr) inStr = null;
      j++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inStr = c; j++; continue; }
    if (c === "{") depth++;
    else if (c === "}") { if (--depth === 0) return j; }
    j++;
  }
  return -1;
}

/**
 * Scan an attribute region `[from, to)` and return parsed attributes. Any
 * `={expr}` / `{shorthand}` values are also appended to `expressions` so the
 * model can extract identifiers from them later.
 */
function scanAttributes(
  text: string,
  from: number,
  to: number,
  expressions: Expression[],
): Attr[] {
  const attrs: Attr[] = [];
  let i = from;

  while (i < to) {
    const c = text[i];
    if (isSpace(c)) { i++; continue; }

    // Shorthand `{name}` (an attribute that is a bare expression).
    if (c === "{") {
      const close = matchBraceBounded(text, i, to);
      const innerStart = i + 1;
      const innerEnd = close === -1 ? to : close;
      const inner = text.slice(innerStart, innerEnd);
      const trimmed = inner.trim();
      const expr: Expression = {
        context: "attr",
        braceStart: i,
        braceEnd: close,
        innerStart,
        innerEnd,
        text: inner,
        identifiers: [],
      };
      expressions.push(expr);
      // Treat a single bare identifier as a shorthand prop.
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(trimmed)) {
        const nameStart = innerStart + inner.indexOf(trimmed);
        attrs.push({
          kind: "shorthand", name: trimmed,
          nameStart, nameEnd: nameStart + trimmed.length,
          braceStart: i, braceEnd: close, exprStart: innerStart, exprEnd: innerEnd,
        });
      }
      i = close === -1 ? to : close + 1;
      continue;
    }

    // Attribute name.
    if (isAttrNameChar(c)) {
      const nameStart = i;
      while (i < to && isAttrNameChar(text[i])) i++;
      const name = text.slice(nameStart, i);
      // Skip whitespace before a possible '='.
      let k = i;
      while (k < to && isSpace(text[k])) k++;
      if (text[k] !== "=") {
        attrs.push({ kind: "boolean", name, nameStart, nameEnd: nameStart + name.length });
        i = k;
        continue;
      }
      const eqOffset = k;
      let v = k + 1;
      while (v < to && isSpace(text[v])) v++;
      const vc = text[v];

      if (vc === '"' || vc === "'") {
        const quoteOpen = v;
        let q = v + 1;
        while (q < to && text[q] !== vc) { if (text[q] === "\\") q++; q++; }
        attrs.push({
          kind: "string", name, nameStart, nameEnd: nameStart + name.length,
          eqOffset, quoteOpen, quoteClose: q < to ? q : undefined,
          strStart: v + 1, strEnd: q < to ? q : to,
        });
        i = q < to ? q + 1 : to;
        continue;
      }

      if (vc === "{") {
        const close = matchBraceBounded(text, v, to);
        const innerStart = v + 1;
        const innerEnd = close === -1 ? to : close;
        expressions.push({
          context: "attr", braceStart: v, braceEnd: close,
          innerStart, innerEnd, text: text.slice(innerStart, innerEnd), identifiers: [],
        });
        attrs.push({
          kind: "expr", name, nameStart, nameEnd: nameStart + name.length,
          eqOffset, braceStart: v, braceEnd: close, exprStart: innerStart, exprEnd: innerEnd,
        });
        i = close === -1 ? to : close + 1;
        continue;
      }

      // Unquoted value: read up to whitespace.
      let u = v;
      while (u < to && !isSpace(text[u])) u++;
      attrs.push({
        kind: "string", name, nameStart, nameEnd: nameStart + name.length,
        eqOffset, strStart: v, strEnd: u,
      });
      i = u;
      continue;
    }

    i++;
  }

  return attrs;
}

/** Like `matchBrace` but never scans past `to`. */
function matchBraceBounded(text: string, i: number, to: number): number {
  let depth = 0;
  let j = i;
  let inStr: string | null = null;
  while (j < to) {
    const c = text[j];
    if (inStr) {
      if (c === "\\") { j += 2; continue; }
      if (c === inStr) inStr = null;
      j++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inStr = c; j++; continue; }
    if (c === "{") depth++;
    else if (c === "}") { if (--depth === 0) return j; }
    j++;
  }
  return -1;
}
