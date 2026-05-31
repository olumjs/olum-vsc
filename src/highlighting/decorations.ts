/**
 * Decoration types — one `TextEditorDecorationType` per color bucket.
 *
 * Built once on activation and reused. Rebuilding on every keystroke would leak
 * native handles, so `dispose` is provided for teardown / color changes.
 */

import * as vscode from "vscode";
import { ColorTheme } from "../utils/colors";

export type Bucket =
  | "comp" | "flow" | "propName" | "propEq" | "strQuote" | "str"
  | "brace" | "num" | "kw" | "nullish" | "varVal" | "forLocal";

export type DecorationSet = Record<Bucket, vscode.TextEditorDecorationType>;

export function createDecorations(c: ColorTheme): DecorationSet {
  const T = (color: string): vscode.TextEditorDecorationType =>
    vscode.window.createTextEditorDecorationType({ color });
  return {
    comp: T(c.comp),
    flow: T(c.flow),
    propName: T(c.propName),
    propEq: T(c.propEq),
    strQuote: T(c.strQuote),
    str: T(c.strContent),
    brace: T(c.brace),
    num: T(c.numVal),
    kw: T(c.boolVal),
    nullish: T(c.nullVal),
    varVal: T(c.varVal),
    forLocal: T(c.forLocal),
  };
}

export function disposeDecorations(set: DecorationSet): void {
  for (const d of Object.values(set)) d.dispose();
}
