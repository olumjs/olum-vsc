/**
 * Highlight colors.
 *
 * Each key maps to one `TextEditorDecorationType` created in
 * `highlighting/decorations.ts`. Edit a hex value and reload the window
 * (`Developer: Reload Window`) to see it take effect.
 */

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

export const colors: ColorTheme = {
  comp: "#FFCB6B", // <ComponentName>            → yellow
  flow: "#89DDFF", // <if> <for> <else> <show>   → cyan
  propName: "#C792EA", // prop key               → purple
  propEq: "#89DDFF", // = separator              → cyan
  strQuote: "#89DDFF", // opening/closing quote  → cyan
  strContent: "#C3E88D", // text inside quotes   → green
  brace: "#ffd700", // { } wrapping a value      → gold
  numVal: "#F78C6C", // number literal           → orange
  boolVal: "#ff9cac", // true / false            → pink
  nullVal: "#89DDFF", // null / undefined        → cyan
  varVal: "#babed8", // variable / identifier    → light blue
  forLocal: "#82AAFF", // <for> local binding    → blue
};
