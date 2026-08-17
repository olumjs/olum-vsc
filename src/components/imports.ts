/**
 * Component import helpers, derived from the script-scope symbol table.
 */

import { Declaration, SymbolTable } from "../scanner/symbols";
import { isPascalCase } from "../utils/helpers";

export interface ComponentImport {
  name: string;
  spec: string;
  nameStart: number;
  nameEnd: number;
}

/** Every import binding in the `<script>` block, in declaration order. */
export function allImports(symbols: SymbolTable): Declaration[] {
  return [...symbols.byName.values()].filter((d) => d.kind === "import" && !!d.importSpec);
}

/**
 * Candidate component imports: PascalCase *default* imports.
 *
 * The default-import test matters — `import { ArrowRight } from "olum-icons"`
 * is also PascalCase, but it is a value used as `{ArrowRight}`, not a tag. The
 * `importKind` fallback keeps older parses (which did not record it) working.
 */
export function componentImports(symbols: SymbolTable): ComponentImport[] {
  const result: ComponentImport[] = [];
  for (const decl of symbols.byName.values()) {
    if (decl.kind !== "import" || !decl.importSpec) continue;
    if (!isPascalCase(decl.name)) continue;
    if (decl.importKind && decl.importKind !== "default") continue;
    result.push({ name: decl.name, spec: decl.importSpec, nameStart: decl.nameStart, nameEnd: decl.nameEnd });
  }
  return result;
}

/** Map of component name → module specifier. */
export function importSpecMap(symbols: SymbolTable): Map<string, string> {
  const map = new Map<string, string>();
  for (const imp of componentImports(symbols)) map.set(imp.name, imp.spec);
  return map;
}
