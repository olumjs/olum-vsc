/**
 * Resolves a component reference to a source file on disk.
 *
 * Resolution order for a tag `<Header />`:
 *   1. If imported (`import Header from "<spec>"`), resolve `<spec>` relative to
 *      the current file, trying the path as-is, then `.html`, then `/index.html`.
 *   2. Otherwise fall back to the project convention `./Header.html` next to the
 *      current file.
 */

import * as fs from "fs";
import * as path from "path";

const CANDIDATE_SUFFIXES = ["", ".html", ".olum.html", "/index.html"];

/** Resolve a module specifier to an existing file path, or null. */
export function resolveSpecifier(spec: string, fromDir: string): string | null {
  const baseResolved = path.resolve(fromDir, spec);
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = suffix && baseResolved.endsWith(".html") ? baseResolved : baseResolved + suffix;
    if (safeExists(candidate)) return candidate;
  }
  return null;
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

function safeExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
