/**
 * Small shared predicates and constants.
 */

import * as vscode from "vscode";

/** The language(s) this extension activates for. */
export const LANGUAGE_ID = "html";
export const HTML_SELECTOR: vscode.DocumentSelector = { language: LANGUAGE_ID, scheme: "file" };

export function isHtmlDocument(document: vscode.TextDocument | undefined): boolean {
  return !!document && /html/i.test(document.languageId);
}

export function isHtmlEditor(editor: vscode.TextEditor | undefined): boolean {
  return !!editor && isHtmlDocument(editor.document);
}

export const isPascalCase = (name: string): boolean => /^[A-Z][A-Za-z0-9]*$/.test(name);

/**
 * Every native HTML element name. Needed because a component import shares its
 * lowercased name with a real element often enough to matter (`Button`/`button`,
 * `Header`/`header`, `Form`/`form`, …) — anything that consumes the lowercased
 * form of a component name must leave genuine HTML tags alone.
 */
const HTML_TAG_NAMES: ReadonlySet<string> = new Set([
  "a", "abbr", "address", "area", "article", "aside", "audio", "b", "base", "bdi",
  "bdo", "big", "blockquote", "body", "br", "button", "canvas", "caption", "center",
  "cite", "code", "col", "colgroup", "data", "datalist", "dd", "del", "details",
  "dfn", "dialog", "div", "dl", "dt", "em", "embed", "fieldset", "figcaption",
  "figure", "font", "footer", "form", "frame", "frameset", "h1", "h2", "h3", "h4",
  "h5", "h6", "head", "header", "hgroup", "hr", "html", "i", "iframe", "image",
  "img", "input", "ins", "kbd", "label", "legend", "li", "link", "main", "map",
  "mark", "marquee", "menu", "meta", "meter", "nav", "nobr", "noembed", "noframes",
  "noscript", "object", "ol", "optgroup", "option", "output", "p", "param",
  "picture", "plaintext", "pre", "progress", "q", "rb", "rp", "rt", "rtc", "ruby",
  "s", "samp", "script", "search", "section", "select", "slot", "small", "source",
  "span", "strike", "strong", "style", "sub", "summary", "sup", "table", "tbody",
  "td", "template", "textarea", "tfoot", "th", "thead", "time", "title", "tr",
  "track", "tt", "u", "ul", "var", "video", "wbr", "xmp",
]);

/** True when `name` (lowercase) is a native HTML element name. */
export const isHtmlTagName = (name: string): boolean => HTML_TAG_NAMES.has(name);

/** Escape a string for safe use inside a `RegExp`. */
export const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
