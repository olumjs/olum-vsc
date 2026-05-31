/**
 * Component import helpers, derived from the script-scope symbol table.
 */

import { SymbolTable } from "../scanner/symbols";
import { isPascalCase } from "../utils/helpers";

export interface ComponentImport {
  name: string;
  spec: string;
  nameStart: number;
  nameEnd: number;
}

/** All PascalCase imports (candidate component imports) in declaration order. */
export function componentImports(symbols: SymbolTable): ComponentImport[] {
  const result: ComponentImport[] = [];
  for (const decl of symbols.byName.values()) {
    if (decl.kind !== "import" || !decl.importSpec) continue;
    if (!isPascalCase(decl.name)) continue;
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
