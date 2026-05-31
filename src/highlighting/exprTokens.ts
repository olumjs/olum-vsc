/**
 * Expression tokenizer used only for syntax highlighting.
 *
 * Unlike `parser/expression` (which extracts identifier *references* for
 * navigation), this returns a full token stream with color categories for the
 * contents between `{` and `}`: strings, numbers, booleans, null/undefined,
 * operators, inner brackets, keywords and identifiers.
 */

export type TokenKind =
  | "quote" | "string" | "number" | "bool" | "nullish"
  | "punct" | "keywordDecl" | "keywordFlow" | "innerBrace" | "ident";

export interface Token {
  kind: TokenKind;
  start: number;
  end: number;
}

const KW_FLOW = new Set([
  "if", "else", "for", "while", "do", "switch", "case", "break", "continue",
  "return", "try", "catch", "finally", "throw", "typeof", "instanceof",
  "in", "of", "async", "await", "delete", "void", "yield",
]);

const KW_DECL = new Set([
  "const", "let", "var", "function", "class", "new", "this", "super",
  "import", "export", "default", "static", "get", "set", "from",
]);

const isIdentStart = (c: string): boolean =>
  (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c === "$";
const isIdentPart = (c: string): boolean => isIdentStart(c) || (c >= "0" && c <= "9");

export function tokenize(text: string, base: number): Token[] {
  const tokens: Token[] = [];
  const n = text.length;
  let i = 0;

  while (i < n) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n") { i++; continue; }

    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      let j = i + 1;
      while (j < n) {
        if (text[j] === "\\") { j += 2; continue; }
        if (text[j] === q) break;
        j++;
      }
      tokens.push({ kind: "quote", start: base + i, end: base + i + 1 });
      if (j > i + 1) tokens.push({ kind: "string", start: base + i + 1, end: base + Math.min(j, n) });
      if (j < n) tokens.push({ kind: "quote", start: base + j, end: base + j + 1 });
      i = j + 1;
      continue;
    }

    if (c === "{" || c === "}" || c === "[" || c === "]" || c === "(" || c === ")") {
      tokens.push({ kind: "innerBrace", start: base + i, end: base + i + 1 });
      i++;
      continue;
    }

    if (c === "=" && text[i + 1] === ">") {
      tokens.push({ kind: "punct", start: base + i, end: base + i + 2 });
      i += 2;
      continue;
    }

    if (c === "?" || c === ":" || c === ",") {
      tokens.push({ kind: "punct", start: base + i, end: base + i + 1 });
      i++;
      continue;
    }

    if ((c >= "0" && c <= "9") || (c === "-" && /[0-9]/.test(text[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < n && /[0-9.]/.test(text[j])) j++;
      tokens.push({ kind: "number", start: base + i, end: base + j });
      i = j;
      continue;
    }

    if (isIdentStart(c)) {
      let j = i;
      while (j < n && isIdentPart(text[j])) j++;
      const word = text.slice(i, j);
      let kind: TokenKind = "ident";
      if (word === "true" || word === "false") kind = "bool";
      else if (word === "null" || word === "undefined") kind = "nullish";
      else if (KW_FLOW.has(word)) kind = "keywordFlow";
      else if (KW_DECL.has(word)) kind = "keywordDecl";
      tokens.push({ kind, start: base + i, end: base + j });
      i = j;
      continue;
    }

    i++;
  }

  return tokens;
}
