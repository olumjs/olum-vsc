/**
 * Highlight colors.
 *
 * Every key maps directly to one TextEditorDecorationType in highlight.js.
 * Edit a hex value here and reload VS Code (Ctrl+Shift+P → "Developer: Reload Window")
 * to see the change take effect immediately.
 *
 * Adding a new color
 * ------------------
 * 1. Add the key/value here.
 * 2. Add a matching entry inside createDecorations() in lib/highlight.js.
 * 3. Accumulate the new ranges in highlight() and call editor.setDecorations() for them.
 * 4. Produce the ranges inside scanPropVals() or tokenizeExpr() in lib/getRange.js.
 */

const colors = {
  // ── tag / block names ─────────────────────────────────────────────────────
  comp:        "#FFCB6B", // <ComponentName>              → yellow
  flow:        "#89DDFF", // <if> <for> <else> <show>     → cyan

  // ── attribute / prop ──────────────────────────────────────────────────────
  propName:    "#C792EA", // the prop key                 → purple
  propEq:      "#89DDFF", // = separator                  → cyan

  // ── string values ─────────────────────────────────────────────────────────
  strQuote:    "#89DDFF", // opening/closing " or '       → cyan
  strContent:  "#C3E88D", // text inside quotes           → green

  // ── brace-wrapped expression values ───────────────────────────────────────
  brace:       "#ffd700", // { } wrapping any prop value  → gold
  numVal:      "#F78C6C", // number literal               → orange
  boolVal:     "#ff9cac", // true / false                 → pink
  nullVal:     "#89DDFF", // null / undefined             → cyan
  varVal:      "#babed8", // variable / identifier        → light blue
};

module.exports = colors;
