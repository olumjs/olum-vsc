/**
 * Resolves a component reference to a source file on disk.
 *
 * Resolution order for a tag `<Header />`:
 *   1. If imported (`import Header from "<spec>"`), resolve `<spec>` relative to
 *      the current file, preferring `.html` candidates.
 *   2. Otherwise fall back to the project convention `./Header.html` next to the
 *      current file.
 *
 * The specifier work itself lives in `modules/resolver`, which also serves plain
 * script imports (`"./utils/cart"`, `"olum-icons/lucide"`); this module only
 * pins the component-flavoured preference and the sibling-file convention.
 */

import { resolveModule } from "../modules/resolver";

/** Resolve a module specifier to an existing file path, or null. */
export function resolveSpecifier(spec: string, fromDir: string): string | null {
  return resolveModule(spec, fromDir, "html");
}

/** Resolve a component by name, using its import spec if known. */
export function resolveComponentFile(
  componentName: string,
  spec: string | undefined,
  fromDir: string,
): string | null {
  if (spec) {
    const viaImport = resolveSpecifier(spec, fromDir);
    if (viaImport) return viaImport;
  }
  // Convention fallback: a sibling file named after the component.
  return resolveSpecifier("./" + componentName, fromDir);
}
