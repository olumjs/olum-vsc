/**
 * Range computation for all syntax highlighting.
 *
 * Exported API
 * ------------
 * getRange(line, index, type)         — tag-name ranges for comp/flow tags
 * scanPropNames(attrsStr, li, off)    — prop key ranges from an attrs substring
 * scanPropVals(attrsStr, li, off)     — all prop value ranges from an attrs substring
 * getPropValRanges(line, index)       — convenience wrapper for single-line tags
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
    // Matches every complete tag on the line and scans each attrs section.
    const tagRe = /<([A-Z][^\s>\/]*)([^>]*)(?:\/?>)/g;
    let tm;
    while ((tm = tagRe.exec(line)) !== null) {
      const off = tm.index + 1 + tm[1].length;
      arr.push(...scanPropNames(tm[2], index, off));
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

// ── expression tokenizer ──────────────────────────────────────────────────────

/**
 * Walks `content` character-by-character and fills the `out` arrays with ranges.
 * Called by scanPropVals for any ={...} expression and for object/array content.
 *
 * `out` fields (all optional — only push if the key exists):
 *   str, strQuote — string literals
 *   num           — number literals
 *   keyword       — true / false  (boolVal color)
 *   nullish       — null, undefined, ?, :, ,  (nullVal color)
 *   varr          — identifiers / variable references  (varVal color)
 *   propName      — { } [ ] inside an expression  (propName/purple color)
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

    // Inner { } [ ] — colored purple (same as prop keys) to distinguish from
    // the outer gold braces added by scanPropVals.
    if (ch === '{' || ch === '}' || ch === '[' || ch === ']') {
      if (out.propName) out.propName.push(C(baseOffset + i));
      i++; continue;
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
      if (word === 'true' || word === 'false')       out.keyword.push(r);
      else if (word === 'null' || word === 'undefined') out.nullish.push(r);
      else                                            out.varr.push(r);
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
    if (ch === '=' && attrsStr[i + 1] === '{') {
      eq.push(C(attrOffset + i));
      brace.push(C(attrOffset + i + 1));          // outer opening {  → gold
      let depth = 0, j = i + 1, inStr = false, strCh = '';
      while (j < attrsStr.length) {
        const c = attrsStr[j];
        if (inStr) {
          if (c === '\\') j++;                    // skip escaped char inside string
          else if (c === strCh) inStr = false;
        } else {
          if (c === '"' || c === "'") { inStr = true; strCh = c; }
          else if (c === '{') depth++;
          else if (c === '}') { if (--depth === 0) { j++; break; } }
        }
        j++;
      }
      brace.push(C(attrOffset + j - 1));          // outer closing }  → gold
      tokenizeExpr(
        attrsStr.slice(i + 2, j - 1),             // content between outer braces
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
  const tagRe = /<([A-Z][^\s>\/]*)([^>]*)(?:\/?>)/g;
  let tm;
  while ((tm = tagRe.exec(line)) !== null) {
    const off = tm.index + 1 + tm[1].length;
    const v = scanPropVals(tm[2], index, off);
    r.str      = r.str.concat(v.str);
    r.strQuote = r.strQuote.concat(v.strQuote);
    r.eq       = r.eq.concat(v.eq);
    r.num      = r.num.concat(v.num);
    r.keyword  = r.keyword.concat(v.keyword);
    r.nullish  = r.nullish.concat(v.nullish);
    r.brace    = r.brace.concat(v.brace);
    r.varr     = r.varr.concat(v.varr);
    r.propName = r.propName.concat(v.propName);
  }
  return r;
}

module.exports = getRange;
module.exports.getPropValRanges = getPropValRanges;
module.exports.scanPropNames    = scanPropNames;
module.exports.scanPropVals     = scanPropVals;
