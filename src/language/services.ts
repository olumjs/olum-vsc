/**
 * Per-document analysis bundle (parsed model + symbol table), memoised against
 * the cached `ParsedDocument` so providers reuse one parse + one symbol scan per
 * document version.
 */

import * as vscode from "vscode";
import { getModel } from "../parser/documentModel";
import { ParsedDocument } from "../parser/types";
import { buildSymbolTable } from "../scanner/scriptScope";
import { SymbolTable } from "../scanner/symbols";

const symbolCache = new WeakMap<ParsedDocument, SymbolTable>();

export interface Analysis {
  model: ParsedDocument;
  symbols: SymbolTable;
}

export function analyze(document: vscode.TextDocument): Analysis {
  const model = getModel(document);
  let symbols = symbolCache.get(model);
  if (!symbols) {
    symbols = buildSymbolTable(model);
    symbolCache.set(model, symbols);
  }
  return { model, symbols };
}
