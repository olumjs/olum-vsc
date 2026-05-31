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

/** Escape a string for safe use inside a `RegExp`. */
export const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
