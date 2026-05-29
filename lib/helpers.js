/**
 * Shared utility predicates used across the extension.
 *
 * isHTML  — guards the highlighter so it only runs on HTML files.
 *           If the extension should also run on a different language (e.g. "olum"),
 *           add it to the regex: /html|olum/i
 *
 * isUpper — used by getRange.js to confirm a tag starts with an uppercase letter,
 *           which is the convention for component names (<MyComponent>).
 */

const isObj     = obj => obj !== null && typeof obj === "object";
const isFullArr = arr => Array.isArray(arr) && arr.length > 0;
const isDef     = val => val !== undefined && val !== null;
const isHTML    = editor => !!(editor?.document && /html/i.test(editor.document.languageId));
const isUpper   = ch => ch >= 'A' && ch <= 'Z';

module.exports = { isUpper, isObj, isFullArr, isDef, isHTML };
