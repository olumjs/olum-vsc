/**
 * Module specifier resolution — the same job Node/bundlers do, reduced to what
 * an editor needs in order to open the file behind an `import`.
 *
 * Handles both shapes olum components actually use:
 *
 *   relative   `"./utils/cart"`, `"../portal"`, `"./Header"`
 *              → tried as-is, then with each candidate extension, then as a
 *                directory with an `index.*` file.
 *   bare       `"olum"`, `"olum-icons/lucide"`
 *              → walks up `node_modules` from the importing file, then reads the
 *                package's `exports` map (subpaths, condition objects and `*`
 *                wildcards), falling back to `module` / `main` / `index.js`.
 *
 * Extension preference is caller-driven: a `<Header />` tag wants `Header.html`,
 * while `import { cart } from "./cart"` wants `cart.js`. Both lists are always
 * tried — only the order changes — so a component imported from a `.js` barrel
 * still resolves.
 *
 * Security: every resolved path is validated to stay inside the open workspace
 * folder(s), so a crafted specifier like `../../.ssh/id_rsa` cannot escape the
 * project.
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

/** Suffixes tried for a component-flavoured specifier. */
const HTML_SUFFIXES = [".html", ".olum.html", "/index.html"];

/** Suffixes tried for a script-flavoured specifier. */
const SCRIPT_SUFFIXES = [
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx",
  "/index.js", "/index.mjs", "/index.cjs", "/index.ts", "/index.jsx", "/index.tsx",
];

/** Which flavour of file the caller is looking for. */
export type ModulePreference = "html" | "script";

/** Conditions honoured when a package `exports` entry is a condition object. */
const EXPORT_CONDITIONS = ["import", "module", "browser", "default", "require", "node"];

/** Resolve any module specifier to an existing file path, or null. */
export function resolveModule(
  spec: string,
  fromDir: string,
  prefer: ModulePreference = "script",
): string | null {
  if (!spec) return null;
  return isRelative(spec)
    ? resolveRelative(spec, fromDir, prefer)
    : resolveBare(spec, fromDir, prefer);
}

/** True for specifiers resolved against the file system rather than node_modules. */
export function isRelative(spec: string): boolean {
  return spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/") || spec === "." || spec === "..";
}

/** Suffix list for a preference, most-wanted first. */
function suffixesFor(prefer: ModulePreference): string[] {
  return prefer === "html"
    ? ["", ...HTML_SUFFIXES, ...SCRIPT_SUFFIXES]
    : ["", ...SCRIPT_SUFFIXES, ...HTML_SUFFIXES];
}

/** Resolve `./x` / `../x` / `/x` against `fromDir`. */
function resolveRelative(spec: string, fromDir: string, prefer: ModulePreference): string | null {
  const base = path.resolve(fromDir, spec);
  if (!isWithinWorkspace(base)) return null;
  return trySuffixes(base, prefer);
}

/** Try `base` as-is and with each candidate suffix; return the first real file. */
function trySuffixes(base: string, prefer: ModulePreference): string | null {
  for (const suffix of suffixesFor(prefer)) {
    // An explicit extension already present must not be doubled up.
    if (suffix && hasKnownExtension(base)) continue;
    const candidate = base + suffix;
    if (isFile(candidate)) return candidate;
  }
  return null;
}

const KNOWN_EXT_RE = /\.(html|js|mjs|cjs|jsx|ts|tsx|json)$/i;
const hasKnownExtension = (p: string): boolean => KNOWN_EXT_RE.test(p);

/**
 * Resolve a bare specifier (`olum`, `olum-icons/lucide`, `@scope/pkg/sub`) by
 * walking `node_modules` upwards from `fromDir`, stopping at the filesystem root.
 */
function resolveBare(spec: string, fromDir: string, prefer: ModulePreference): string | null {
  const { pkgName, subpath } = splitBareSpec(spec);
  if (!pkgName) return null;

  for (const dir of ancestorDirs(fromDir)) {
    const pkgDir = path.join(dir, "node_modules", pkgName);
    if (!isDirectory(pkgDir)) continue;
    const file = resolveInPackage(pkgDir, subpath, prefer);
    if (file && isWithinWorkspace(file)) return file;
    if (file) return null; // found the package but it lives outside the workspace
  }
  return null;
}

/** Split `@scope/pkg/a/b` into its package name and `./a/b` subpath. */
export function splitBareSpec(spec: string): { pkgName: string; subpath: string } {
  const parts = spec.split("/").filter(Boolean);
  if (parts.length === 0) return { pkgName: "", subpath: "." };
  const take = parts[0].startsWith("@") ? 2 : 1;
  const pkgName = parts.slice(0, take).join("/");
  const rest = parts.slice(take);
  return { pkgName, subpath: rest.length ? "./" + rest.join("/") : "." };
}

/** Resolve `subpath` inside an installed package directory. */
function resolveInPackage(pkgDir: string, subpath: string, prefer: ModulePreference): string | null {
  const manifest = readJson(path.join(pkgDir, "package.json"));

  if (manifest && manifest.exports !== undefined) {
    const target = resolveExports(manifest.exports, subpath);
    if (target) {
      const file = path.resolve(pkgDir, target);
      if (isFile(file)) return file;
      const viaSuffix = trySuffixes(file, prefer);
      if (viaSuffix) return viaSuffix;
    }
  }

  if (subpath !== ".") {
    return trySuffixes(path.resolve(pkgDir, subpath), prefer);
  }

  for (const field of ["module", "main"]) {
    const value = manifest && typeof manifest[field] === "string" ? (manifest[field] as string) : null;
    if (!value) continue;
    const file = path.resolve(pkgDir, value);
    if (isFile(file)) return file;
    const viaSuffix = trySuffixes(file, prefer);
    if (viaSuffix) return viaSuffix;
  }

  return trySuffixes(path.join(pkgDir, "index"), prefer);
}

/**
 * Resolve `subpath` against a package's `exports` field. Supports the string
 * form, the subpath-map form, condition objects, and a single `*` wildcard —
 * which together cover every real package layout the extension meets.
 */
export function resolveExports(exportsField: unknown, subpath: string): string | null {
  if (typeof exportsField === "string") return subpath === "." ? exportsField : null;
  if (!exportsField || typeof exportsField !== "object" || Array.isArray(exportsField)) return null;

  const map = exportsField as Record<string, unknown>;
  const keys = Object.keys(map);

  // A map whose keys are not subpaths is a condition object for "." itself.
  if (!keys.some((k) => k === "." || k.startsWith("./"))) {
    return subpath === "." ? pickCondition(map) : null;
  }

  const exact = map[subpath];
  if (exact !== undefined) return pickCondition(exact);

  // Wildcard patterns, longest (most specific) prefix first.
  const patterns = keys.filter((k) => k.includes("*")).sort((a, b) => b.length - a.length);
  for (const pattern of patterns) {
    const [prefix, suffix] = pattern.split("*", 2);
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix ?? "")) continue;
    const star = subpath.slice(prefix.length, subpath.length - (suffix ?? "").length);
    const target = pickCondition(map[pattern]);
    if (target) return target.replace("*", star);
  }
  return null;
}

/** Reduce an `exports` value (string, or condition object) to a target path. */
function pickCondition(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const conditions = value as Record<string, unknown>;
  for (const condition of EXPORT_CONDITIONS) {
    if (conditions[condition] === undefined) continue;
    const resolved = pickCondition(conditions[condition]);
    if (resolved) return resolved;
  }
  return null;
}

/** `dir` and every ancestor of it, nearest first. */
function ancestorDirs(dir: string): string[] {
  const dirs: string[] = [];
  let current = path.resolve(dir);
  for (;;) {
    dirs.push(current);
    const parent = path.dirname(current);
    if (parent === current) return dirs;
    current = parent;
  }
}

/**
 * Returns true only when `p` is inside one of the open workspace folders.
 * Prevents path-traversal via crafted import specs (e.g. `../../.ssh/id_rsa`).
 */
export function isWithinWorkspace(p: string): boolean {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return true; // no workspace open — allow (dev mode)
  const normalized = p.endsWith(path.sep) ? p : p + path.sep;
  return folders.some((f) => normalized.startsWith(f.uri.fsPath + path.sep));
}

export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Read and parse a JSON file, or null when missing/invalid. */
export function readJson(p: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}
