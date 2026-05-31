/**
 * Highlight colors.
 *
 * Defaults live here; actual values come from the `olum.colors.*` VS Code
 * settings so users can tweak them in settings.json without recompiling.
 * Changes take effect immediately — no window reload needed.
 *
 * Each key maps to one `TextEditorDecorationType` in `highlighting/decorations.ts`.
 */

import * as vscode from "vscode";

export interface ColorTheme {
  comp: string;
  flow: string;
  propName: string;
  propEq: string;
  strQuote: string;
  strContent: string;
  brace: string;
  numVal: string;
  boolVal: string;
  nullVal: string;
  varVal: string;
  /** Local variables introduced by <for> (e.g. `item`). */
  forLocal: string;
}

const DEFAULTS: ColorTheme = {
  comp:       "#FFCB6B", // <ComponentName>            → yellow
  flow:       "#89DDFF", // <if> <for> <else> <show>   → cyan
  propName:   "#C792EA", // prop key                   → purple
  propEq:     "#89DDFF", // = separator                → cyan
  strQuote:   "#89DDFF", // opening/closing quote      → cyan
  strContent: "#C3E88D", // text inside quotes         → green
  brace:      "#ffd700", // { } wrapping a value       → gold
  numVal:     "#F78C6C", // number literal             → orange
  boolVal:    "#ff9cac", // true / false               → pink
  nullVal:    "#89DDFF", // null / undefined           → cyan
  varVal:     "#babed8", // variable / identifier      → light blue
  forLocal:   "#82AAFF", // <for> local binding        → blue
};

/** Read the current color theme from `olum.colors.*` settings, falling back to defaults. */
export function getColors(): ColorTheme {
  const c = vscode.workspace.getConfiguration("olum.colors");
  return {
    comp:       c.get("component",    DEFAULTS.comp),
    flow:       c.get("flow",         DEFAULTS.flow),
    propName:   c.get("propName",     DEFAULTS.propName),
    propEq:     c.get("propEquals",   DEFAULTS.propEq),
    strQuote:   c.get("stringQuote",  DEFAULTS.strQuote),
    strContent: c.get("stringValue",  DEFAULTS.strContent),
    brace:      c.get("brace",        DEFAULTS.brace),
    numVal:     c.get("number",       DEFAULTS.numVal),
    boolVal:    c.get("boolean",      DEFAULTS.boolVal),
    nullVal:    c.get("null",         DEFAULTS.nullVal),
    varVal:     c.get("variable",     DEFAULTS.varVal),
    forLocal:   c.get("forLocal",     DEFAULTS.forLocal),
  };
}
