import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../src/cli.js";

test("parses a quoted prompt and flags", () => {
  assert.deepEqual(parseArgs(["--yes", "--max-steps", "4", "find duplicates"]), {
    yes: true,
    dryRun: false,
    maxSteps: 4,
    check: false,
    setup: false,
    help: false,
    prompt: "find duplicates",
  });
});

test("rejects unknown options", () => {
  assert.throws(() => parseArgs(["--wat"]), /Unknown option/);
});

test("defaults to one fast command", () => {
  assert.equal(parseArgs(["list files"]).maxSteps, 1);
});

test("accepts a named one-run dangerous override", () => {
  assert.equal(parseArgs(["--dangerous", "touch file"]).yes, true);
});
