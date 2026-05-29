const vscode = require('vscode');
const fs     = require('fs');
const path   = require('path');

// ── JSONC parser ──────────────────────────────────────────────────────────────
function stripComments(src) {
  let out = '', inStr = false, escaped = false, i = 0;
  while (i < src.length) {
    const c = src[i];
    if (escaped)                          { out += c; escaped = false; i++; continue; }
    if (c === '\\' && inStr)              { out += c; escaped = true;  i++; continue; }
    if (c === '"')                        { inStr = !inStr; out += c;  i++; continue; }
    if (!inStr && c === '/' && src[i+1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (!inStr && c === '/' && src[i+1] === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i+1] === '/')) i++; i += 2; continue; }
    out += c; i++;
  }
  return out;
}

function parseFile(filePath) {
  try { return JSON.parse(stripComments(fs.readFileSync(filePath, 'utf8'))); }
  catch { return null; }
}

// ── Theme file resolution ─────────────────────────────────────────────────────
function findThemeFile(themeName) {
  for (const ext of vscode.extensions.all) {
    const themes = (ext.packageJSON?.contributes?.themes) || [];
    for (const t of themes) {
      if (t.label === themeName || t.id === themeName) {
        return path.join(ext.extensionPath, t.path);
      }
    }
  }
  return null;
}

// Collect tokenColors, following "include" chains
function collectTokenColors(filePath, visited = new Set()) {
  if (visited.has(filePath)) return [];
  visited.add(filePath);
  const data = parseFile(filePath);
  if (!data) return [];
  let colors = [];
  if (data.include) {
    colors = collectTokenColors(path.resolve(path.dirname(filePath), data.include), visited);
  }
  return colors.concat(data.tokenColors || []);
}

// ── Scope resolver (TextMate longest-prefix wins) ────────────────────────────
function resolveScope(tokenColors, scope) {
  const parts = scope.split('.');
  let best = { score: -1, color: null };
  for (const rule of tokenColors) {
    const fg = rule.settings?.foreground;
    if (!fg) continue;
    const raw = rule.scope || '';
    const scopes = Array.isArray(raw) ? raw : raw.split(',').map(s => s.trim()).filter(Boolean);
    for (const s of scopes) {
      const sp = s.split('.');
      if (parts.slice(0, sp.length).join('.') === sp.join('.') && sp.length > best.score) {
        best = { score: sp.length, color: fg };
      }
    }
  }
  return best.color;
}

// ── Public API ────────────────────────────────────────────────────────────────
function loadColors(fallback) {
  const themeName = vscode.workspace.getConfiguration('workbench').get('colorTheme');
  const themeFile = findThemeFile(themeName);
  if (!themeFile) return { ...fallback };

  const tokenColors = collectTokenColors(themeFile);
  if (!tokenColors.length) return { ...fallback };

  const R = (scope, key) => resolveScope(tokenColors, scope) || fallback[key];

  return {
    comp:       R('support.class.component',             'comp'),
    flow:       R('keyword.control',                     'flow'),
    propName:   R('entity.other.attribute-name',         'propName'),
    propEq:     R('punctuation.separator.key-value',     'propEq'),
    strQuote:   R('punctuation.definition.string.begin', 'strQuote'),
    strContent: R('string.quoted',                       'strContent'),
    brace:      fallback['brace'],
    numVal:     R('constant.numeric',                    'numVal'),
    boolVal:    R('constant.language.boolean',           'boolVal'),
    nullVal:    R('constant.language',                   'nullVal'),
  };
}

module.exports = { loadColors };
