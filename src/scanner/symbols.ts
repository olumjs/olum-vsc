/**
 * Symbol model for declarations found in `<script>` blocks, plus the type
 * inference and label formatting used by hover.
 */

export type SymbolKind =
  | "const" | "let" | "var"
  | "function" | "method" | "property"
  | "import" | "module" | "class"
  | "object" | "prop";

export interface Declaration {
  name: string;
  kind: SymbolKind;
  /** Absolute offset of the declared name. */
  nameStart: number;
  nameEnd: number;
  /** Inferred type label, when available. */
  type?: string;
  /** Parameter list source for functions/methods. */
  params?: string;
  /** Leading documentation comment, when present. */
  doc?: string;
  /** Module specifier for imports. */
  importSpec?: string;
  /** Top-level members for object declarations (property name → declaration). */
  members?: Map<string, Declaration>;
  /** True for implicit symbols (e.g. `props`) that have no real declaration. */
  synthetic?: boolean;
}

export interface SymbolTable {
  byName: Map<string, Declaration>;
  lookup(name: string): Declaration | undefined;
  lookupMember(objectName: string, prop: string): Declaration | undefined;
}

/** Heuristically infer a TypeScript-style type label from a raw value string. */
export function inferType(raw: string): string {
  const v = (raw || "").trim();
  if (/^['"`]/.test(v)) return "string";
  if (/^-?\d+(\.\d+)?$/.test(v)) return "number";
  if (v === "true" || v === "false") return "boolean";
  if (v === "null") return "null";
  if (v === "undefined") return "undefined";
  if (v.startsWith("[")) return "any[]";
  if (v.includes("=>") || v.startsWith("function")) return "Function";
  if (v.startsWith("{")) return "object";
  if (/^new\s+([A-Za-z_$][\w$]*)/.test(v)) return RegExp.$1;
  return "any";
}

/** Format a declaration into a VS Code-style signature line. */
export function buildLabel(decl: Declaration): string {
  switch (decl.kind) {
    case "function":
    case "method":
      return `(${decl.kind}) ${decl.name}(${decl.params ?? ""}): void`;
    case "module":
    case "import":
      return `(${decl.kind}) ${decl.name}`;
    case "class":
      return `(class) ${decl.name}`;
    case "object":
      return `(${"const"}) ${decl.name}: object`;
    default:
      return `(${decl.kind}) ${decl.name}: ${decl.type ?? "any"}`;
  }
}

/** Synthetic implicit symbols available to every olum component. */
export const IMPLICIT_SYMBOLS: ReadonlyArray<Declaration> = [
  { name: "props", kind: "prop", nameStart: -1, nameEnd: -1, type: "any", synthetic: true,
    doc: "Implicit component props passed by the parent." },
];
