/**
 * Builds a symbol table from the `<script>` block(s) of an olum component.
 *
 * Declarations only exist inside `<script>`, so extraction is scoped to those
 * regions. All offsets returned are absolute document offsets, ready for
 * go-to-definition. The table also resolves object members (`obj.prop`) and
 * exposes implicit symbols such as `props`.
 *
 * This is regex-assisted rather than a full JS parser: it covers the forms olum
 * components actually use (imports, top-level declarations, `this.` fields,
 * object literals) and degrades gracefully for anything exotic.
 */

import { ParsedDocument } from "../parser/types";
import { Declaration, IMPLICIT_SYMBOLS, inferType, SymbolTable } from "./symbols";

export function buildSymbolTable(model: ParsedDocument): SymbolTable {
  const byName = new Map<string, Declaration>();

  const add = (decl: Declaration): void => {
    if (!byName.has(decl.name)) byName.set(decl.name, decl);
  };

  for (const region of model.scriptRegions) {
    const base = region.start;
    const src = model.text.slice(region.start, region.end);
    extractRegion(src, base, add);
  }

  for (const sym of IMPLICIT_SYMBOLS) add({ ...sym });

  return {
    byName,
    lookup: (name) => byName.get(name),
    lookupMember: (objectName, prop) => {
      const obj = byName.get(objectName);
      return obj?.members?.get(prop);
    },
  };
}

function extractRegion(src: string, base: number, add: (d: Declaration) => void): void {
  let m: RegExpExecArray | null;

  // ── default imports: import Name from "spec" ──────────────────────────────
  const importRe = /\bimport\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"]/g;
  while ((m = importRe.exec(src))) {
    const nameStart = base + m.index + m[0].indexOf(m[1]);
    add({ name: m[1], kind: "import", nameStart, nameEnd: nameStart + m[1].length,
      importSpec: m[2], doc: docAbove(src, m.index) });
  }

  // ── named imports: import { a, b } from "spec" ────────────────────────────
  const namedRe = /\bimport\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  while ((m = namedRe.exec(src))) {
    const groupStart = m.index + m[0].indexOf("{") + 1;
    const inner = m[1];
    const idRe = /([A-Za-z_$][\w$]*)/g;
    let idm: RegExpExecArray | null;
    while ((idm = idRe.exec(inner))) {
      const nameStart = base + groupStart + idm.index;
      add({ name: idm[1], kind: "import", nameStart, nameEnd: nameStart + idm[1].length, importSpec: m[2] });
    }
  }

  // ── function declarations ─────────────────────────────────────────────────
  const fnRe = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g;
  while ((m = fnRe.exec(src))) {
    const nameStart = base + m.index + m[0].indexOf(m[1]);
    add({ name: m[1], kind: "function", nameStart, nameEnd: nameStart + m[1].length,
      params: m[2].trim(), doc: docAbove(src, m.index) });
  }

  // ── class declarations ────────────────────────────────────────────────────
  const classRe = /\bclass\s+([A-Za-z_$][\w$]*)/g;
  while ((m = classRe.exec(src))) {
    const nameStart = base + m.index + m[0].indexOf(m[1]);
    add({ name: m[1], kind: "class", nameStart, nameEnd: nameStart + m[1].length, doc: docAbove(src, m.index) });
  }

  // ── arrow-function consts: const fn = (...) => ────────────────────────────
  const arrowRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g;
  while ((m = arrowRe.exec(src))) {
    const nameStart = base + m.index + m[0].indexOf(m[1]);
    add({ name: m[1], kind: "function", nameStart, nameEnd: nameStart + m[1].length,
      params: m[2].replace(/^\(|\)$/g, "").trim(), doc: docAbove(src, m.index) });
  }

  // ── object-literal consts: const obj = { ... } ────────────────────────────
  const objRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\{/g;
  while ((m = objRe.exec(src))) {
    const braceOffset = m.index + m[0].length - 1;
    const nameStart = base + m.index + m[0].indexOf(m[1]);
    const decl: Declaration = {
      name: m[1], kind: "object", nameStart, nameEnd: nameStart + m[1].length,
      doc: docAbove(src, m.index), members: new Map(),
    };
    parseObjectMembers(src, braceOffset, base, decl.members!);
    add(decl);
  }

  // ── generic value consts (fallback) ───────────────────────────────────────
  const genRe = /\b(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n,}]+)/g;
  while ((m = genRe.exec(src))) {
    const nameStart = base + m.index + m[0].indexOf(m[2]);
    add({ name: m[2], kind: m[1] as Declaration["kind"], nameStart, nameEnd: nameStart + m[2].length,
      type: inferType(m[3]), doc: docAbove(src, m.index) });
  }

  // ── this.x = value (class fields) ─────────────────────────────────────────
  const thisRe = /\bthis\.([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g;
  while ((m = thisRe.exec(src))) {
    const nameStart = base + m.index + m[0].indexOf(m[1]);
    add({ name: m[1], kind: "property", nameStart, nameEnd: nameStart + m[1].length, type: inferType(m[2]) });
  }
}

/**
 * Parse the *top-level* `key: value` / `method() {}` members of an object
 * literal whose opening `{` is at `braceOffset`. Walks the body tracking bracket
 * depth and string state so nested object keys are not mistaken for members.
 */
function parseObjectMembers(
  src: string,
  braceOffset: number,
  base: number,
  out: Map<string, Declaration>,
): void {
  const n = src.length;
  let depth = 0;
  let inStr: string | null = null;
  let atKeyPosition = true; // start of body, or just after a top-level comma
  let i = braceOffset;

  for (; i < n; i++) {
    const c = src[i];

    if (inStr) {
      if (c === "\\") { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inStr = c; atKeyPosition = false; continue; }

    if (c === "{" || c === "[" || c === "(") {
      depth++;
      if (depth > 1) atKeyPosition = false;
      continue;
    }
    if (c === "}" || c === "]" || c === ")") {
      depth--;
      if (depth === 0) break; // end of this object literal
      continue;
    }
    if (depth !== 1) continue; // ignore everything nested deeper than the body

    if (c === ",") { atKeyPosition = true; continue; }
    if (/\s/.test(c)) continue;

    if (atKeyPosition && /[A-Za-z_$]/.test(c)) {
      const s = i;
      while (i < n && /[\w$]/.test(src[i])) i++;
      const name = src.slice(s, i);
      let k = i;
      while (k < n && /\s/.test(src[k])) k++;
      const isMethod = src[k] === "(";
      if (src[k] === ":" || isMethod) {
        const nameStart = base + s;
        if (!out.has(name)) {
          out.set(name, isMethod
            ? { name, kind: "method", nameStart, nameEnd: nameStart + name.length, params: "" }
            : { name, kind: "property", nameStart, nameEnd: nameStart + name.length, type: inferType(readValue(src, k + 1)) });
        }
      }
      i--; // re-process the char that ended the identifier
      atKeyPosition = false;
      continue;
    }
    atKeyPosition = false;
  }
}

/** Read an object-property value starting at `from`, up to the next top-level `,` or `}`. */
function readValue(src: string, from: number): string {
  const n = src.length;
  let depth = 0;
  let inStr: string | null = null;
  let i = from;
  for (; i < n; i++) {
    const c = src[i];
    if (inStr) {
      if (c === "\\") { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") { if (depth === 0) break; depth--; }
    else if (c === "," && depth === 0) break;
  }
  return src.slice(from, i).trim();
}

/** Grab a `//` or `/** *​/` documentation comment immediately above `index`. */
function docAbove(src: string, index: number): string | undefined {
  const before = src.slice(0, index);
  const lines = before.split(/\r?\n/);
  // Drop the (partial) current line.
  lines.pop();
  const collected: string[] = [];
  for (let li = lines.length - 1; li >= 0; li--) {
    const line = lines[li].trim();
    if (line === "") { if (collected.length) break; else continue; }
    if (line.startsWith("//")) { collected.unshift(line.replace(/^\/\/\s?/, "")); continue; }
    if (line.endsWith("*/") || line.startsWith("*") || line.startsWith("/*")) {
      collected.unshift(line.replace(/^\/?\*+\/?\s?/, "").replace(/\s*\*\/$/, ""));
      if (line.startsWith("/*")) break;
      continue;
    }
    break;
  }
  const doc = collected.join("\n").trim();
  return doc || undefined;
}
