/**
 * Range computation for all syntax highlighting.
 *
 * Exported API
 * ------------
 * getRange(line, index, type)         — tag-name ranges for comp/flow tags
 * scanPropNames(attrsStr, li, off)    — prop key ranges from an attrs substring
 * scanPropVals(attrsStr, li, off)     — all prop value ranges from an attrs substring
 * getPropValRanges(line, index)       — convenience wrapper for single-line tags
 * tokenizeExprToRanges(content, li, off) — tokenize expression content, return ranges object
 *
 * Data flow
 * ---------
 * highlight.js splits the document into lines and calls these functions per line.
 * Results are VS Code Range objects that get passed to editor.setDecorations().
 *
 * Adding a new flow tag (e.g. <while>)
 * -------------------------------------
 * 1. Add an entry to the META table inside getRange() below.
 * 2. Add a matching entry to FLOW_TAGS in lib/highlight.js.
 * That's it — no other files need changing.
 *
 * Adding a new value type (e.g. RegExp literals)
 * ------------------------------------------------
 * 1. Add a color key to lib/colors.js.
 * 2. Add a matching decoration in createDecorations() in lib/highlight.js.
 * 3. Add an accumulator array and setDecorations() call in highlight().
 * 4. Detect and push ranges inside tokenizeExpr() or scanPropVals().
 */

const vscode = require("vscode");
const { isUpper } = require("./helpers");

// ── low-level range builders ──────────────────────────────────────────────────

function mkR(li, s, e) { return new vscode.Range(new vscode.Position(li, s), new vscode.Position(li, e)); }
function mkC(li, col)  { return mkR(li, col, col + 1); }

// ── tag-name ranges (comp / flow) ─────────────────────────────────────────────

/**
 * Returns an array of Ranges for component or flow tag *names* on a single line.
 *
 * type "comp"    — self-closing component:  <MyComp ... />
 * type "comp2"   — opening/closing pair:    <MyComp> … </MyComp>
 * type "prop"    — delegates to scanPropNames for all tags on the line
 * type "if" etc. — flow keywords; data-driven via the META table
 *
 * Returns false (not []) when nothing is found so callers can do `if (range)`.
 */
function getRange(line, index, type) {
  const arr = [];

  if (type === "comp") {
    const m = /<([A-Z][^\s>\/]*)/.exec(line);
    if (m) arr.push(mkR(index, m.index + 1, m.index + 1 + m[1].length));

  } else if (type === "comp2") {
    const mo = /<([A-Z][^\s>\/]*)/.exec(line);
    if (mo) arr.push(mkR(index, mo.index + 1, mo.index + 1 + mo[1].length));
    const mc = /<\/([A-Z][^\s>\/]*)/.exec(line);
    if (mc) arr.push(mkR(index, mc.index + 2, mc.index + 2 + mc[1].length));

  } else if (type === "prop") {
    // Brace-aware: iterateCompTags handles `>` inside ={...} expressions correctly.
    for (const { attrsStr, attrOffset, isClose } of iterateCompTags(line)) {
      if (!isClose) arr.push(...scanPropNames(attrsStr, index, attrOffset));
    }

  } else {
    // Flow tag keyword ranges — add new tags here.
    const META = {
      "if":      { len: 2, openRe: /<if(?=[\s>\/])/,      closeRe: /<\/if>/      },
      "else-if": { len: 7, openRe: /<else-if(?=[\s>\/])/, closeRe: /<\/else-if>/ },
      "else":    { len: 4, openRe: /<else(?=[\s>\/])/,    closeRe: /<\/else>/    },
      "for":     { len: 3, openRe: /<for(?=[\s>\/])/,     closeRe: /<\/for>/     },
      "show":    { len: 4, openRe: /<show(?=[\s>\/])/,    closeRe: /<\/show>/    },
    };
    const meta = META[type];
    if (meta) {
      let m;
      if ((m = meta.openRe.exec(line)))  arr.push(mkR(index, m.index + 1, m.index + 1 + meta.len));
      if ((m = meta.closeRe.exec(line))) arr.push(mkR(index, m.index + 2, m.index + 2 + meta.len));
    }
  }

  return arr.length ? arr : false;
}

// ── prop-name scanner ─────────────────────────────────────────────────────────

/**
 * Finds all `propName=` occurrences inside an attrs substring and returns their
 * ranges. `attrOffset` is the column in the original line where `attrsStr` starts.
 *
 * Example: for `<Comp foo="x" bar={y}>` called with the ` foo="x" bar={y}` slice,
 * attrOffset would be the column right after "Comp".
 */
function scanPropNames(attrsStr, lineIndex, attrOffset) {
  const arr = [];
  const re = /(?:^|\s)([a-zA-Z_][a-zA-Z0-9_]*)=/g;
  let m;
  while ((m = re.exec(attrsStr)) !== null) {
    const wsLen = m[0].indexOf(m[1]);
    const start = attrOffset + m.index + wsLen;
    arr.push(mkR(lineIndex, start, start + m[1].length));
  }
  return arr;
}

// Control-flow keywords — pushed into the `nullish` (cyan) bucket so they share
// the same color as null / undefined / ternary operators without needing a new
// decoration type.
const JS_KW_FLOW = new Set([
  "if","else","for","while","do","switch","case","break","continue",
  "return","try","catch","finally","throw","typeof","instanceof",
  "in","of","async","await","delete","void","yield",
]);

// Declaration keywords — pushed into the `propName` (purple) bucket so they share
// the same color as prop keys and inner braces without needing a new decoration type.
const JS_KW_DECL = new Set([
  "const","let","var","function","class","new","this","super",
  "import","export","default","static","get","set","from",
]);

// ── expression tokenizer ──────────────────────────────────────────────────────

/**
 * Walks `content` character-by-character and fills the `out` arrays with ranges.
 * Called by scanPropVals for any ={...} expression and for object/array content.
 *
 * `out` fields (all optional — only push if the key exists):
 *   str, strQuote — string literals
 *   num           — number literals
 *   keyword       — true / false  (boolVal / pink)
 *   nullish       — null, undefined, ?, :, ,, =>, JS_KW_FLOW  (nullVal / cyan)
 *   varr          — identifiers / variable references  (varVal / light blue)
 *   propName      — { } [ ] ( ) inside an expression + JS_KW_DECL  (propName / purple)
 *
 * Keyword routing: JS_KW_FLOW words go to `nullish` (cyan) and JS_KW_DECL words
 * go to `propName` (purple) — both reuse existing decoration types so no new
 * colors or setDecorations calls are needed.
 *
 * Important: use regex character classes (not raw char-code ranges) for
 * identifier detection. Char-code hacks like `>= 48` accidentally include ':'
 * (code 58) and break `true:` splitting in ternary expressions.
 */
function tokenizeExpr(content, lineIndex, baseOffset, out) {
  const R = (s, e) => mkR(lineIndex, s, e);
  const C = col    => mkC(lineIndex, col);
  let i = 0;
  while (i < content.length) {
    const ch = content[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { i++; continue; }

    // String literal  " ... "  or  ' ... '
    if (ch === '"' || ch === "'") {
      const q = ch;
      let j = i + 1;
      while (j < content.length) {
        if (content[j] === '\\') { j += 2; continue; } // skip escape sequence
        if (content[j] === q) break;
        j++;
      }
      out.strQuote.push(C(baseOffset + i));                              // opening quote
      if (j > i + 1) out.str.push(R(baseOffset + i + 1, baseOffset + j)); // content
      out.strQuote.push(C(baseOffset + j));                              // closing quote
      i = j + 1; continue;
    }

    // Inner { } [ ] ( ) — colored purple (same as prop keys) to distinguish from
    // the outer gold braces added by scanPropVals.
    if (ch === '{' || ch === '}' || ch === '[' || ch === ']' || ch === '(' || ch === ')') {
      if (out.propName) out.propName.push(C(baseOffset + i));
      i++; continue;
    }

    // Arrow operator => — two-character lookahead so the > isn't consumed as unknown.
    if (ch === '=' && content[i + 1] === '>') {
      out.nullish.push(R(baseOffset + i, baseOffset + i + 2));
      i += 2; continue;
    }

    // Ternary operators and object separators
    if (ch === '?' || ch === ':' || ch === ',') {
      out.nullish.push(C(baseOffset + i));
      i++; continue;
    }

    // Identifier or keyword — MUST use /[a-zA-Z_$]/ and /[a-zA-Z0-9_$.]/ here.
    if (/[a-zA-Z_$]/.test(ch)) {
      let j = i;
      while (j < content.length && /[a-zA-Z0-9_$.]/.test(content[j])) j++;
      const word = content.slice(i, j);
      const r = R(baseOffset + i, baseOffset + j);
      if (word === 'true' || word === 'false')          out.keyword.push(r);  // pink
      else if (word === 'null' || word === 'undefined') out.nullish.push(r);  // cyan
      else if (JS_KW_FLOW.has(word))                   out.nullish.push(r);  // cyan
      else if (JS_KW_DECL.has(word))                   out.propName.push(r); // purple
      else                                              out.varr.push(r);
      i = j; continue;
    }

    // Number literal (including negative: -42, -3.14)
    if (/\d/.test(ch) || (ch === '-' && /\d/.test(content[i + 1] || ''))) {
      let j = i + 1;
      while (j < content.length && /[\d.]/.test(content[j])) j++;
      out.num.push(R(baseOffset + i, baseOffset + j));
      i = j; continue;
    }

    i++; // unknown character — skip (VS Code's own tokenizer handles it)
  }
}

// ── brace-aware tag iterator ──────────────────────────────────────────────────

/**
 * Finds all *complete* component tags on a line, being brace-aware.
 * Returns an array of { nameStart, name, attrOffset, attrsStr, isClose }.
 *
 * "Brace-aware" means a `>` that appears inside a `{...}` prop expression
 * (e.g. the `>` in `=>`) is NOT treated as the tag's closing `>`.  The simple
 * `[^>]*` regex that most tag scanners use gets this wrong, which is why
 * `onclick={() => {...}}` props were not highlighted.
 *
 * Only tags whose real closing `>` is found on this line are returned.  A tag
 * like `<Header onclick={() =>` (no actual `>` at brace-depth 0) produces no
 * entry, so highlight.js correctly falls through to the multi-line branch.
 */
function iterateCompTags(line) {
  const results = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] !== '<') { i++; continue; }
    const isClose   = line[i + 1] === '/';
    const nameStart = isClose ? i + 2 : i + 1;
    if (nameStart >= line.length || !/[A-Z]/.test(line[nameStart])) { i++; continue; }
    // Read tag name (stop at whitespace, >, or /)
    let j = nameStart;
    while (j < line.length && /[^\s>\/]/.test(line[j])) j++;
    const name       = line.slice(nameStart, j);
    const attrOffset = j;
    // Brace-aware scan to the true closing >
    let depth = 0, inStr = false, strCh = '', end = -1;
    while (j < line.length) {
      const c = line[j];
      if (inStr) {
        if (c === '\\') j++;           // skip escaped char
        else if (c === strCh) inStr = false;
      } else {
        if (c === '"' || c === "'") { inStr = true; strCh = c; }
        else if (c === '{') depth++;
        else if (c === '}') depth--;
        else if (c === '>' && depth === 0) { end = j; break; } // real tag end
      }
      j++;
    }
    if (end !== -1) {
      results.push({ nameStart, name, attrOffset, attrsStr: line.slice(attrOffset, end), isClose });
      i = end + 1;
    } else {
      i = j; // no closing > found at depth 0 — multi-line opener, skip
    }
  }
  return results;
}

// ── prop-value scanner (single linear walk) ───────────────────────────────────

/**
 * Scans an attrs substring for all prop *values* in one linear pass.
 *
 * Handles:
 *   name="string"    name='string'    →  strQuote + strContent
 *   name={expr}                       →  brace (outer { }) + tokenizeExpr content
 *   {shorthand}                       →  brace + varVal  (Svelte-style shorthand)
 *
 * The ={...} handler uses a brace-depth counter so nested objects/arrays like
 * ={{a:1}} and ={[1,2,3]} are parsed correctly without a separate regex for each
 * value type.  tokenizeExpr then classifies each token inside the braces.
 *
 * Returns an object with nine Range arrays — same keys as `out` in tokenizeExpr
 * plus `eq` (the `=` sign) and `brace` (the outer gold { }).
 */
function scanPropVals(attrsStr, lineIndex, attrOffset) {
  const str = [], strQuote = [], eq = [], num = [], keyword = [],
        nullish = [], brace = [], varr = [], propName = [];
  const C = col => mkC(lineIndex, col);
  const R = (s, e) => mkR(lineIndex, s, e);

  let i = 0;
  while (i < attrsStr.length) {
    const ch = attrsStr[i];

    // ── ="..." or ='...' ──────────────────────────────────────────────────
    if (ch === '=' && (attrsStr[i + 1] === '"' || attrsStr[i + 1] === "'")) {
      const q = attrsStr[i + 1];
      eq.push(C(attrOffset + i));
      const qOpen = attrOffset + i + 1;
      strQuote.push(C(qOpen));
      let j = i + 2;
      while (j < attrsStr.length) {
        if (attrsStr[j] === '\\') { j += 2; continue; }
        if (attrsStr[j] === q) break;
        j++;
      }
      if (j > i + 2) str.push(R(qOpen + 1, attrOffset + j));
      strQuote.push(C(attrOffset + j));
      i = j + 1; continue;
    }

    // ── ={...} ────────────────────────────────────────────────────────────
    // Brace-depth walk handles nesting (={{...}}, ={[...]}, ternaries, etc.)
    // without needing separate regex patterns for each value type.
    // When the expression doesn't close on this line (multi-line arrow fn etc.),
    // `closed` stays false and we skip the closing-brace push to avoid coloring
    // the wrong character. highlight.js continues tokenizing on subsequent lines.
    if (ch === '=' && attrsStr[i + 1] === '{') {
      eq.push(C(attrOffset + i));
      brace.push(C(attrOffset + i + 1));          // outer opening {  → gold
      let depth = 0, j = i + 1, inStr = false, strCh = '', closed = false;
      while (j < attrsStr.length) {
        const c = attrsStr[j];
        if (inStr) {
          if (c === '\\') j++;                    // skip escaped char inside string
          else if (c === strCh) inStr = false;
        } else {
          if (c === '"' || c === "'") { inStr = true; strCh = c; }
          else if (c === '{') depth++;
          else if (c === '}') { if (--depth === 0) { j++; closed = true; break; } }
        }
        j++;
      }
      if (closed) brace.push(C(attrOffset + j - 1)); // outer closing } → gold
      tokenizeExpr(
        attrsStr.slice(i + 2, closed ? j - 1 : j), // tokenize whatever is on this line
        lineIndex,
        attrOffset + i + 2,
        { str, strQuote, num, keyword, nullish, varr, propName }
      );
      i = j; continue;
    }

    // ── {varName} shorthand (Svelte-style, no = prefix) ──────────────────
    // Detected by finding a standalone { not preceded by =.
    if (ch === '{' && (i === 0 || attrsStr[i - 1] !== '=')) {
      let j = i + 1;
      while (j < attrsStr.length && attrsStr[j] !== '}') j++;
      const raw     = attrsStr.slice(i + 1, j);
      const trimmed = raw.trim();
      const isKw    = trimmed === 'true'  || trimmed === 'false'
                   || trimmed === 'null'  || trimmed === 'undefined';
      if (!isKw && /^[a-zA-Z_$][a-zA-Z0-9_$.]*$/.test(trimmed)) {
        brace.push(C(attrOffset + i));
        brace.push(C(attrOffset + j));
        const start = attrOffset + i + 1 + raw.indexOf(trimmed);
        varr.push(R(start, start + trimmed.length));
      }
      i = j + 1; continue;
    }

    i++;
  }

  return { str, strQuote, eq, num, keyword, nullish, brace, varr, propName };
}

// ── single-line tag helper ────────────────────────────────────────────────────

/**
 * Convenience wrapper: finds all complete component tags on a single line and
 * returns the merged prop-value ranges for all of them.
 * Used by highlight.js for single-line component detection.
 */
function getPropValRanges(line, index) {
  const r = { str: [], strQuote: [], eq: [], num: [], keyword: [], nullish: [], brace: [], varr: [], propName: [] };
  // iterateCompTags is brace-aware so `>` inside ={...} (e.g. `=>`) is never
  // mistaken for the tag's closing `>`, giving scanPropVals the full attrs string.
  for (const { attrsStr, attrOffset, isClose } of iterateCompTags(line)) {
    if (isClose) continue;
    const v = scanPropVals(attrsStr, index, attrOffset);
    for (const k of Object.keys(r)) r[k] = r[k].concat(v[k] || []);
  }
  return r;
}

// Convenience wrapper: run tokenizeExpr on content and return the ranges object.
// Used by highlight.js to colorize continuation lines inside multi-line expressions.
function tokenizeExprToRanges(content, lineIndex, baseOffset) {
  const out = { str: [], strQuote: [], eq: [], num: [], keyword: [], nullish: [], brace: [], varr: [], propName: [] };
  tokenizeExpr(content, lineIndex, baseOffset, out);
  return out;
}

module.exports = getRange;
module.exports.getPropValRanges     = getPropValRanges;
module.exports.scanPropNames        = scanPropNames;
module.exports.scanPropVals         = scanPropVals;
module.exports.tokenizeExprToRanges = tokenizeExprToRanges;
module.exports.iterateCompTags      = iterateCompTags;
