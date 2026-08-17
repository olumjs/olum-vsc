#!/usr/bin/env node
/**
 * Test entry point — `npm test`.
 *
 * Requires the harness first so the `vscode` stub is installed before any
 * compiled module is loaded, then runs each suite in order and exits non-zero
 * if anything failed.
 */

const { summary } = require("./harness");

const SUITES = [
  "./parser.test",
  "./symbols.test",
  "./modules.test",
  "./highlighting.test",
  "./providers.test",
  "./utils.test",
  "./extension.test",
];

(async () => {
  for (const suite of SUITES) {
    const run = require(suite);
    await run();
  }
  process.exit(summary() ? 0 : 1);
})();
