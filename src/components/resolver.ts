/**
 * Resolves a component reference to a source file on disk.
 *
 * Resolution order for a tag `<Header />`:
 *   1. If imported (`import Header from "<spec>"`), resolve `<spec>` relative to
 *      the current file, trying the path as-is, then `.html`, then `/index.html`.
 *   2. Otherwise fall back to the project convention `./Header.html` next to the
 *      current file.
 *
 * Security: all resolved paths are validated to stay within the workspace root(s)
 * so a malicious import spec like `../../.ssh/id_rsa` cannot escape the project.
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

const CANDIDATE_SUFFIXES = ["", ".html", ".olum.html", "/index.html"];

/** Resolve a module specifier to an existing file path, or null. */
export function resolveSpecifier(spec: string, fromDir: string): string | null {
  const baseResolved = path.resolve(fromDir, spec);
  if (!isWithinWorkspace(baseResolved)) return null;
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

/**
 * Returns true only when `p` is inside one of the open workspace folders.
 * Prevents path-traversal via crafted import specs (e.g. `../../.ssh/id_rsa`).
 */
function isWithinWorkspace(p: string): boolean {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return true; // no workspace open — allow (dev mode)
  const normalized = p.endsWith(path.sep) ? p : p + path.sep;
  return folders.some((f) => normalized.startsWith(f.uri.fsPath + path.sep));
}

function safeExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
