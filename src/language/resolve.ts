/**
 * Shared symbol resolution for the template region.
 *
 * Every language feature (hover, definition, references, rename) starts here:
 * given an offset, classify what is under the cursor and collect all reference
 * ranges for that symbol. `<for>` locals shadow same-named script variables
 * within their body, which is handled centrally so all features agree.
 *
 * Anything inside a `<script>`/`<style>` region resolves to `null`, satisfying
 * the requirement that those blocks are excluded from framework analysis.
 */

import {
  expressionAt,
  isInRawRegion,
} from "../parser/documentModel";
import { ForScope, ParsedDocument } from "../parser/types";

export interface OffsetRange {
  start: number;
  end: number;
}

export type ResolvedTarget =
  | { type: "variable"; name: string; hit: OffsetRange }
  | { type: "member"; objectName: string; name: string; hit: OffsetRange }
  | { type: "forLocal"; name: string; scope: ForScope; hit: OffsetRange }
  | { type: "component"; name: string; hit: OffsetRange };

/** Innermost `<for>` scope containing `offset` that declares `name`. */
function declaringScope(model: ParsedDocument, offset: number, name: string): ForScope | null {
  let best: ForScope | null = null;
  for (const s of model.forScopes) {
    if (offset < s.bodyStart || offset >= s.bodyEnd) continue;
    if (!s.locals.some((l) => l.name === name)) continue;
    if (!best || s.bodyStart > best.bodyStart) best = s;
  }
  return best;
}

/** Classify the symbol at `offset`, or null when there is nothing navigable. */
export function resolveTarget(model: ParsedDocument, offset: number): ResolvedTarget | null {
  if (isInRawRegion(model, offset)) return null;

  // ── component tag name ────────────────────────────────────────────────────
  for (const tag of model.components) {
    if (offset >= tag.nameStart && offset <= tag.nameEnd) {
      return { type: "component", name: tag.name, hit: { start: tag.nameStart, end: tag.nameEnd } };
    }
  }

  // ── a <for> local declaration token (the `todo` in each={todo of ...}) ─────
  for (const scope of model.forScopes) {
    for (const local of scope.locals) {
      if (offset >= local.start && offset <= local.end) {
        return { type: "forLocal", name: local.name, scope, hit: { start: local.start, end: local.end } };
      }
    }
  }

  // ── an identifier inside an expression ─────────────────────────────────────
  const expr = expressionAt(model, offset);
  if (expr) {
    for (const id of expr.identifiers) {
      if (offset < id.start || offset > id.end) continue;
      if (id.role === "member") {
        return { type: "member", objectName: id.objectName ?? id.rootName, name: id.name, hit: { start: id.start, end: id.end } };
      }
      const ds = declaringScope(model, id.start, id.name);
      if (ds) return { type: "forLocal", name: id.name, scope: ds, hit: { start: id.start, end: id.end } };
      return { type: "variable", name: id.name, hit: { start: id.start, end: id.end } };
    }
  }

  return null;
}

/** All reference ranges for a resolved target, across the template. */
export function referenceRanges(model: ParsedDocument, target: ResolvedTarget): OffsetRange[] {
  const ranges: OffsetRange[] = [];

  switch (target.type) {
    case "component": {
      for (const tag of model.components) {
        if (tag.name === target.name) ranges.push({ start: tag.nameStart, end: tag.nameEnd });
      }
      break;
    }
    case "member": {
      for (const expr of model.expressions) {
        for (const id of expr.identifiers) {
          if (id.role === "member" && id.name === target.name && (id.objectName ?? id.rootName) === target.objectName) {
            ranges.push({ start: id.start, end: id.end });
          }
        }
      }
      break;
    }
    case "forLocal": {
      for (const local of target.scope.locals) {
        if (local.name === target.name) ranges.push({ start: local.start, end: local.end });
      }
      for (const expr of model.expressions) {
        for (const id of expr.identifiers) {
          if (id.role !== "root" || id.name !== target.name) continue;
          if (declaringScope(model, id.start, id.name) === target.scope) {
            ranges.push({ start: id.start, end: id.end });
          }
        }
      }
      break;
    }
    case "variable": {
      for (const expr of model.expressions) {
        for (const id of expr.identifiers) {
          if (id.role !== "root" || id.name !== target.name) continue;
          if (declaringScope(model, id.start, id.name) === null) {
            ranges.push({ start: id.start, end: id.end });
          }
        }
      }
      break;
    }
  }

  // De-duplicate (a token can only appear once, but member/variable scans are broad).
  const seen = new Set<string>();
  return ranges.filter((r) => {
    const k = `${r.start}:${r.end}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
