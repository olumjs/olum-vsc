/**
 * Main highlighter.
 *
 * How it works
 * ------------
 * VS Code's decoration API lets extensions paint arbitrary color ranges on top of
 * whatever the grammar-based tokenizer produces. This file:
 *   1. Creates one TextEditorDecorationType per color (createDecorations).
 *   2. On every text change, re-scans the whole document line by line (highlight).
 *   3. Accumulates Range arrays for each decoration type.
 *   4. Calls editor.setDecorations() once per type at the end.
 *
 * Decoration types are built once (or rebuilt when colors change) and reused.
 * Rebuilding them is cheap; rebuilding on every keystroke would be wasteful.
 *
 * Multi-line component state
 * --------------------------
 * The `inComp` flag tracks whether the current line is a continuation of a
 * component tag that started on a previous line:
 *
 *   <MyComponent          ← RE_ML_START matches, inComp = true
 *     propA="val"         ← continuation: scan props only
 *     propB={42}          ← continuation: scan props only
 *   />                    ← RE_ML_STRIP matches, inComp = false
 *
 * Adding a new flow tag (e.g. <while>)
 * -------------------------------------
 * Add one entry to FLOW_TAGS:
 *   { openRe: /<while(?=[\s>\/])/, closeRe: /<\/while>/, len: 5 }
 * Also add it to the META table in lib/getRange.js getRange().
 *
 * Adding a new decoration color
 * ------------------------------
 * 1. Add the color key to lib/colors.js.
 * 2. Add `newKey: T(c.newKey)` inside createDecorations().
 * 3. Add a `charsNew = []` accumulator below.
 * 4. Merge ranges into it (via pushVals or directly).
 * 5. Call `editor.setDecorations(DEC.newKey, charsNew)` at the bottom.
 */

const vscode   = require("vscode");
const { isFullArr, isHTML } = require("../lib/helpers");
const getRange = require("../lib/getRange");

// ── pre-compiled patterns (created once, not per-line) ────────────────────────

// Matches any *complete* component tag on a line (self-closing, opening, or closing).
// Returns false for multi-line openers that have no closing > yet.
const RE_COMP_HAS   = /<\/?([A-Z][^\s>\/]*)(?:[^>]*)>/;

// Used with matchAll() to collect all component names on a single-line.
const RE_COMP_OPEN  = /<([A-Z][^\s>\/]*)/g;   // opening / self-closing names
const RE_COMP_CLOSE = /<\/([A-Z][^\s>\/]*)/g;  // closing tag names

// Detects the first line of a multi-line component: <ComponentName (no > yet).
// Groups: [1] leading whitespace, [2] tag name, [3] rest of line (may have attrs).
const RE_ML_START   = /^(\s*)<([A-Z][^\s>\/]*)(.*)$/;

// Strips the closing /> or > (plus trailing whitespace) from a continuation line
// so only the attr portion remains.
const RE_ML_STRIP   = /\s*\/?>[\s]*$/;

// Flow tag descriptors — one entry per keyword.
// openRe / closeRe: non-global, used with exec() (no lastIndex state issues).
// len: character count of the keyword itself (used to compute the range end).
const FLOW_TAGS = [
  { openRe: /<if(?=[\s>\/])/,      closeRe: /<\/if>/,      len: 2 },
  { openRe: /<else-if(?=[\s>\/])/, closeRe: /<\/else-if>/, len: 7 },
  { openRe: /<else(?=[\s>\/])/,    closeRe: /<\/else>/,    len: 4 },
  { openRe: /<for(?=[\s>\/])/,     closeRe: /<\/for>/,     len: 3 },
  { openRe: /<show(?=[\s>\/])/,    closeRe: /<\/show>/,    len: 4 },
];

// ── decoration state ──────────────────────────────────────────────────────────

// DEC is null until createDecorations() is called from bin/index.js.
// Calling setDecorations before DEC is ready is a no-op (guarded at top of highlight).
let DEC = null;

/**
 * Rebuild all decoration types from a colors object.
 * Must be called before highlight() will do anything.
 * Old types are disposed to avoid memory leaks.
 */
function createDecorations(c) {
  if (DEC) Object.values(DEC).forEach(d => d.dispose());
  const T = color => vscode.window.createTextEditorDecorationType({ color });
  DEC = {
    comp:     T(c.comp),
    flow:     T(c.flow),
    propName: T(c.propName),
    propEq:   T(c.propEq),
    strQuote: T(c.strQuote),
    str:      T(c.strContent),
    brace:    T(c.brace),
    num:      T(c.numVal),
    kw:       T(c.boolVal),
    nullish:  T(c.nullVal),
    varVal:   T(c.varVal),
  };
}

// ── main highlighter ──────────────────────────────────────────────────────────

const highlight = () => {
  if (!DEC) return;
  const editor = vscode.window.activeTextEditor;
  if (!isHTML(editor)) return;

  const lines = editor.document.getText().split("\n");
  if (!isFullArr(lines)) return;

  // One accumulator array per decoration type.
  // All ranges are collected first, then applied in a single batch at the end.
  const chars        = [], charsFlow     = [];
  const charsPropName= [], charsPropEq   = [];
  const charsStrQuote= [], charsStr      = [];
  const charsBrace   = [], charsNum      = [];
  const charsKw      = [], charsNull     = [], charsVar = [];

  const mkR = (li, s, e) =>
    new vscode.Range(new vscode.Position(li, s), new vscode.Position(li, e));

  // Merge a scanPropVals result into the accumulator arrays.
  function pushVals(v) {
    if (v.eq.length)       charsPropEq.push(...v.eq);
    if (v.strQuote.length) charsStrQuote.push(...v.strQuote);
    if (v.str.length)      charsStr.push(...v.str);
    if (v.brace.length)    charsBrace.push(...v.brace);
    if (v.num.length)      charsNum.push(...v.num);
    if (v.keyword.length)  charsKw.push(...v.keyword);
    if (v.nullish.length)  charsNull.push(...v.nullish);
    if (v.varr.length)     charsVar.push(...v.varr);
    if (v.propName.length) charsPropName.push(...v.propName);
  }

  // inComp tracks whether we're inside a multi-line component tag.
  // Resets to false at document start; set to true when RE_ML_START matches,
  // cleared when the closing /> or > is found.
  let inComp = false;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];

    if (!inComp) {
      if (RE_COMP_HAS.test(line)) {
        // ── single-line component(s) ──────────────────────────────────────
        // Collect every component name on this line (there can be more than one).
        for (const m of line.matchAll(RE_COMP_OPEN))
          chars.push(mkR(index, m.index + 1, m.index + 1 + m[1].length));
        for (const m of line.matchAll(RE_COMP_CLOSE))
          chars.push(mkR(index, m.index + 2, m.index + 2 + m[1].length));
        // Prop names and values.
        const propRanges = getRange(line, index, "prop");
        if (propRanges) charsPropName.push(...propRanges);
        pushVals(getRange.getPropValRanges(line, index));

      } else {
        // ── multi-line component opener ───────────────────────────────────
        // RE_ML_START only matches when there is no > on the line, so genuine
        // single-line tags are already handled by the branch above.
        const ml = RE_ML_START.exec(line);
        if (ml) {
          inComp = true;
          const nameStart = ml[1].length + 1;             // skip indent + '<'
          chars.push(mkR(index, nameStart, nameStart + ml[2].length));
          const attrOffset = nameStart + ml[2].length;    // column after tag name
          const propRanges = getRange.scanPropNames(ml[3], index, attrOffset);
          if (propRanges.length) charsPropName.push(...propRanges);
          pushVals(getRange.scanPropVals(ml[3], index, attrOffset));
        }
      }
    } else {
      // ── multi-line continuation line ──────────────────────────────────────
      // Strip /> or > before scanning so the closing marker isn't mistaken for
      // part of an attribute value.
      const closesTag = /\/>/.test(line) || line.trimEnd().endsWith('>');
      const attrsLine = closesTag ? line.replace(RE_ML_STRIP, '') : line;
      const propRanges = getRange.scanPropNames(attrsLine, index, 0);
      if (propRanges.length) charsPropName.push(...propRanges);
      pushVals(getRange.scanPropVals(attrsLine, index, 0));
      if (closesTag) inComp = false;
    }

    // ── flow tags ──────────────────────────────────────────────────────────
    // Processed on every line, even inside a multi-line component, because
    // flow tags are independent of component nesting.
    for (const { openRe, closeRe, len } of FLOW_TAGS) {
      let m;
      if ((m = openRe.exec(line))) {
        charsFlow.push(mkR(index, m.index + 1, m.index + 1 + len));
        chars.push(mkR(index, m.index, m.index + 1));                          // <
        const gt = line.indexOf('>', m.index);
        if (gt !== -1) {
          chars.push(mkR(index, gt, gt + 1));                                  // >
          // Highlight prop names and values inside the attrs section (e.g. cond={...}).
          const attrsStart = m.index + m[0].length;
          const attrsStr   = line.slice(attrsStart, gt);
          const pnRanges   = getRange.scanPropNames(attrsStr, index, attrsStart);
          if (pnRanges.length) charsPropName.push(...pnRanges);
          pushVals(getRange.scanPropVals(attrsStr, index, attrsStart));
        }
      }
      if ((m = closeRe.exec(line))) {
        charsFlow.push(mkR(index, m.index + 2, m.index + 2 + len));
        chars.push(mkR(index, m.index, m.index + 1));                          // <
        chars.push(mkR(index, m.index + m[0].length - 1, m.index + m[0].length)); // >
      }
    }
  }

  // Apply all decorations in one batch. Later setDecorations calls win on
  // overlapping ranges, so the order here determines which color shows on top.
  editor.setDecorations(DEC.comp,     chars);
  editor.setDecorations(DEC.flow,     charsFlow);
  editor.setDecorations(DEC.propName, charsPropName);
  editor.setDecorations(DEC.propEq,   charsPropEq);
  editor.setDecorations(DEC.strQuote, charsStrQuote);
  editor.setDecorations(DEC.str,      charsStr);
  editor.setDecorations(DEC.brace,    charsBrace);
  editor.setDecorations(DEC.num,      charsNum);
  editor.setDecorations(DEC.kw,       charsKw);
  editor.setDecorations(DEC.nullish,  charsNull);
  editor.setDecorations(DEC.varVal,   charsVar);
};

module.exports = highlight;
module.exports.createDecorations = createDecorations;
