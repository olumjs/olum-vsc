/**
 * Index of every importable symbol the workspace can offer, so `<script>` gets
 * the same auto-import completions a `.js` file gets from the TypeScript server.
 *
 * Two sources feed the index:
 *
 *   local     every `.js`/`.mjs`/`.ts` file in the workspace (node_modules and
 *             build output excluded). Their specifier is relative, so it is
 *             computed per importing file rather than stored.
 *   package   the `dependencies` of the nearest `package.json`, entered through
 *             each package's `exports` subpaths (or `main`). Their specifier is
 *             fixed (`"olum"`, `"olum-icons/lucide"`, …).
 *
 * Export extraction is regex-based rather than a real parse: it covers the
 * `export` forms that appear in published ESM and in hand-written app code, and
 * ignores anything exotic instead of guessing.
 *
 * Both halves are cached. Local files are re-read only when their mtime changes;
 * packages never change without a reinstall, so they are cached for the session.
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { isFile, readJson, resolveExports, resolveModule } from "./resolver";

/** One importable symbol, ready to be turned into a completion item. */
export interface ModuleExport {
  /** Local binding a consumer would write (`cart`, `ArrowRight`, `Header`). */
  name: string;
  /** Absolute path of the file that declares it. */
  file: string;
  /** Fixed specifier for package exports; undefined for workspace files. */
  spec?: string;
  /** True when the symbol is the module's default export. */
  isDefault: boolean;
}

/** Files larger than this are skipped — a bundle is not a useful import source. */
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

/** How long a built local index is trusted before its files are re-stat'ed. */
const LOCAL_TTL_MS = 4000;

const LOCAL_GLOB = "**/*.{js,mjs,ts}";
const LOCAL_EXCLUDE = "**/{node_modules,dist,build,out,.git,coverage}/**";
const MAX_LOCAL_FILES = 800;

// ── caches ───────────────────────────────────────────────────────────────────

interface FileExports {
  mtimeMs: number;
  names: string[];
  hasDefault: boolean;
  /** Name the default export declares, when it has one (`export default class Toast`). */
  defaultName?: string;
}

const fileCache = new Map<string, FileExports>();
const packageCache = new Map<string, ModuleExport[]>(); // keyed by package.json path

let localCache: ModuleExport[] = [];
let localBuiltAt = 0;
let localBuilding: Promise<ModuleExport[]> | null = null;

/** Drop every cache. Called when files change on disk. */
export function invalidateExportIndex(): void {
  fileCache.clear();
  packageCache.clear();
  localCache = [];
  localBuiltAt = 0;
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * Every symbol importable from `fromFile`, the workspace's own modules first:
 * a package like `olum-icons` contributes thousands of names, and the caller
 * caps the list, so app code has to come first to survive the cut.
 */
export async function importableSymbols(fromFile: string): Promise<ModuleExport[]> {
  const [pkgs, locals] = await Promise.all([
    packageExports(fromFile),
    localExports(),
  ]);
  return [...locals.filter((e) => e.file !== fromFile), ...pkgs];
}

/**
 * Offset of `name`'s declaration inside `file`, or -1 when it cannot be pinned
 * down. Used by go-to-definition to land on the symbol instead of line 1.
 */
export function exportOffset(file: string, name: string, isDefault: boolean): number {
  const src = readSource(file);
  if (src === null) return -1;

  if (isDefault) {
    const m = /\bexport\s+default\b/.exec(src);
    return m ? m.index : -1;
  }

  // `export const|let|var|function|async function|class NAME`
  const declRe = new RegExp(
    `\\bexport\\s+(?:async\\s+)?(?:const|let|var|function\\*?|class)\\s+(${escape(name)})\\b`,
  );
  const decl = declRe.exec(src);
  if (decl) return decl.index + decl[0].lastIndexOf(name);

  // `export { A, B as NAME }` — the local binding, or the alias when renamed.
  const groupRe = /\bexport\s*\{([^}]*)\}/g;
  let g: RegExpExecArray | null;
  while ((g = groupRe.exec(src))) {
    const inner = g[1];
    const entryRe = new RegExp(`(?:^|,)\\s*([A-Za-z_$][\\w$]*)(?:\\s+as\\s+(${escape(name)}))?\\s*(?=,|$)`, "g");
    let e: RegExpExecArray | null;
    while ((e = entryRe.exec(inner))) {
      const exported = e[2] ?? e[1];
      if (exported !== name) continue;
      const groupStart = g.index + g[0].indexOf("{") + 1;
      return groupStart + e.index + e[0].indexOf(e[1]);
    }
  }

  // Declared plainly and exported elsewhere.
  const plain = new RegExp(`\\b(?:const|let|var|function\\*?|class)\\s+(${escape(name)})\\b`).exec(src);
  return plain ? plain.index + plain[0].lastIndexOf(name) : -1;
}

/** Import specifier to reach `targetFile` from `fromDir`, extension stripped. */
export function relativeSpecifier(fromDir: string, targetFile: string): string {
  let rel = path.relative(fromDir, targetFile).replace(/\\/g, "/");
  rel = rel.replace(/\.(js|mjs|cjs|jsx|ts|tsx|html)$/i, "").replace(/\/index$/, "");
  if (rel === "") rel = ".";
  if (!rel.startsWith(".")) rel = "./" + rel;
  return rel;
}

// ── local (workspace) files ──────────────────────────────────────────────────

async function localExports(): Promise<ModuleExport[]> {
  if (Date.now() - localBuiltAt < LOCAL_TTL_MS) return localCache;
  if (localBuilding) return localBuilding;

  localBuilding = buildLocalExports()
    .then((result) => {
      localCache = result;
      localBuiltAt = Date.now();
      return result;
    })
    .finally(() => { localBuilding = null; });

  return localBuilding;
}

async function buildLocalExports(): Promise<ModuleExport[]> {
  const uris = await vscode.workspace.findFiles(LOCAL_GLOB, LOCAL_EXCLUDE, MAX_LOCAL_FILES);
  const out: ModuleExport[] = [];
  for (const uri of uris) {
    const entry = fileExports(uri.fsPath);
    if (!entry) continue;
    for (const name of entry.names) out.push({ name, file: uri.fsPath, isDefault: false });
    for (const name of defaultBindingNames(entry, fileBasedName(uri.fsPath))) {
      out.push({ name, file: uri.fsPath, isDefault: true });
    }
  }
  return out;
}

/**
 * Names a default export can be reached by, best first.
 *
 * A default import binds to whatever name you write, so both the name the module
 * declares (`export default function createStore`) and a name derived from where
 * it lives (`store.js` → `store`) produce a correct import. Offering both is what
 * makes the symbol findable — searching for either one is equally natural, and
 * `store.js` exporting `createStore` is common enough that picking only one of
 * them loses the symbol for half of all searches.
 */
function defaultBindingNames(entry: FileExports, fallback: string): string[] {
  if (!entry.hasDefault) return [];
  if (!entry.defaultName) return [fallback];
  return entry.defaultName === fallback ? [entry.defaultName] : [entry.defaultName, fallback];
}

/** Binding name derived from a file's path (`cart.js` → `cart`, `x/index.js` → `x`). */
function fileBasedName(file: string): string {
  const base = path.basename(file).replace(/\.[^.]+$/, "");
  const cleaned = base === "index" ? path.basename(path.dirname(file)) : base;
  return identifierize(cleaned);
}

/** Last path segment of a specifier (`olum-icons/lucide` → `lucide`). */
function lastSegment(spec: string): string {
  const parts = spec.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? spec;
}

/** Turn an arbitrary path or package segment into a usable JS identifier. */
function identifierize(raw: string): string {
  const camel = raw.replace(/[^A-Za-z0-9_$]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ""));
  return /^[A-Za-z_$]/.test(camel) ? camel : "_" + camel;
}

// ── package dependencies ─────────────────────────────────────────────────────

async function packageExports(fromFile: string): Promise<ModuleExport[]> {
  const manifestPath = nearestManifest(path.dirname(fromFile));
  if (!manifestPath) return [];

  const cached = packageCache.get(manifestPath);
  if (cached) return cached;

  const manifest = readJson(manifestPath);
  const deps = manifest && typeof manifest.dependencies === "object" && manifest.dependencies
    ? Object.keys(manifest.dependencies as Record<string, string>)
    : [];

  const fromDir = path.dirname(manifestPath);
  const out: ModuleExport[] = [];
  for (const dep of deps) {
    for (const spec of packageEntrySpecs(dep, fromDir)) {
      const file = resolveModule(spec, fromDir, "script");
      if (!file) continue;
      const entry = fileExports(file);
      if (!entry) continue;
      for (const name of entry.names) out.push({ name, file, spec, isDefault: false });
      // A package's default export is reached by the spec's last segment
      // (`olum-store` → `olumStore`, `olum-icons/lucide` → `lucide`).
      for (const name of defaultBindingNames(entry, identifierize(lastSegment(spec)))) {
        out.push({ name, file, spec, isDefault: true });
      }
    }
  }

  packageCache.set(manifestPath, out);
  return out;
}

/**
 * The specifiers a package can be imported through: its root, plus every literal
 * `exports` subpath. Wildcard subpaths are skipped — they stand for whole
 * directories and would flood the completion list.
 */
function packageEntrySpecs(pkgName: string, fromDir: string): string[] {
  const pkgJson = resolveModule(pkgName + "/package.json", fromDir, "script")
    ?? findPackageJson(pkgName, fromDir);
  const manifest = pkgJson ? readJson(pkgJson) : null;
  const specs = [pkgName];

  const exportsField = manifest?.exports;
  if (exportsField && typeof exportsField === "object" && !Array.isArray(exportsField)) {
    for (const key of Object.keys(exportsField as Record<string, unknown>)) {
      if (key === "." || !key.startsWith("./") || key.includes("*")) continue;
      if (!resolveExports(exportsField, key)) continue;
      specs.push(pkgName + key.slice(1));
    }
  }
  return specs;
}

/** Locate an installed package's manifest by walking node_modules upwards. */
function findPackageJson(pkgName: string, fromDir: string): string | null {
  let current = path.resolve(fromDir);
  for (;;) {
    const candidate = path.join(current, "node_modules", pkgName, "package.json");
    if (isFile(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Nearest `package.json` at or above `dir`. */
function nearestManifest(dir: string): string | null {
  let current = path.resolve(dir);
  for (;;) {
    const candidate = path.join(current, "package.json");
    if (isFile(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// ── export extraction ────────────────────────────────────────────────────────

/** How deep `export * from "…"` chains are followed before giving up. */
const MAX_STAR_DEPTH = 4;

/** Exports of a single file, re-reading it only when its mtime moved. */
function fileExports(file: string, seen: Set<string> = new Set(), depth = 0): FileExports | null {
  let mtimeMs: number;
  try {
    const stat = fs.statSync(file);
    if (stat.size > MAX_SOURCE_BYTES) return null;
    mtimeMs = stat.mtimeMs;
  } catch {
    return null;
  }

  const cached = fileCache.get(file);
  if (cached && cached.mtimeMs === mtimeMs) return cached;

  const src = readSource(file);
  if (src === null) return null;

  const parsed = parseExports(src);
  const names = new Set(parsed.names);

  // `export * from "./other"` re-exports names this file never spells out, so a
  // barrel built that way would otherwise look empty. Followed depth-first with
  // a visited set, because barrels re-exporting each other is not unusual.
  if (depth < MAX_STAR_DEPTH && !seen.has(file)) {
    seen.add(file);
    const dir = path.dirname(file);
    for (const spec of starReexports(src)) {
      const target = resolveModule(spec, dir, "script");
      if (!target || seen.has(target)) continue;
      const nested = fileExports(target, seen, depth + 1);
      if (nested) for (const name of nested.names) names.add(name);
    }
  }

  const entry: FileExports = {
    mtimeMs, names: [...names], hasDefault: parsed.hasDefault, defaultName: parsed.defaultName,
  };
  // Only a top-level result is cached: a nested one may have been cut short by
  // the depth cap or the cycle guard, and caching that would poison the file.
  if (depth === 0) fileCache.set(file, entry);
  return entry;
}

/** Specifiers of every `export * from "…"` in `src` (the `* as ns` form excluded). */
function starReexports(src: string): string[] {
  const specs: string[] = [];
  const re = /\bexport\s*\*\s*from\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) specs.push(m[1]);
  return specs;
}

/**
 * The name a default export declares, if any — `export default function
 * createStore`, `export default class Toast`, `export default apiClient;`.
 * Anonymous defaults (`export default {…}`, `export default () => …`) have none.
 */
export function defaultExportName(src: string): string | undefined {
  const declared = /\bexport\s+default\s+(?:async\s+)?(?:function\*?|class)\s+([A-Za-z_$][\w$]*)/.exec(src);
  if (declared) return declared[1];
  const binding = /\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*;/.exec(src);
  return binding ? binding[1] : undefined;
}

/** Every exported binding name in `src`, plus whether it has a default export. */
export function parseExports(src: string): { names: string[]; hasDefault: boolean; defaultName?: string } {
  const names = new Set<string>();
  let hasDefault = false;
  let m: RegExpExecArray | null;

  // export const|let|var|function|async function|class NAME
  const declRe = /\bexport\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = declRe.exec(src))) names.add(m[1]);

  // export { A, B as C }  /  export { A, B as C } from "..."
  const groupRe = /\bexport\s*\{([^}]*)\}/g;
  while ((m = groupRe.exec(src))) {
    for (const part of m[1].split(",")) {
      const entry = part.trim();
      if (!entry) continue;
      const as = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(entry);
      const exported = as ? as[2] : entry;
      if (!/^[A-Za-z_$][\w$]*$/.test(exported)) continue;
      if (exported === "default") { hasDefault = true; continue; }
      names.add(exported);
    }
  }

  // export * as ns from "..."
  const nsRe = /\bexport\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\b/g;
  while ((m = nsRe.exec(src))) names.add(m[1]);

  if (/\bexport\s+default\b/.test(src)) hasDefault = true;

  return { names: [...names], hasDefault, defaultName: hasDefault ? defaultExportName(src) : undefined };
}

function readSource(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
