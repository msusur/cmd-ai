import test from "node:test";
import assert from "node:assert/strict";
import { formatModelUsage, formatVerboseDiagnostics, isAffirmative, parseArgs } from "../src/cli.js";

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

test("accepts only explicit yes confirmations", () => {
  assert.equal(isAffirmative("y"), true);
  assert.equal(isAffirmative(" YES "), true);
  assert.equal(isAffirmative("n"), false);
  assert.equal(isAffirmative(""), false);
});

test("formats model token and context usage", () => {
  assert.equal(
    formatModelUsage({ inputTokens: 1200, outputTokens: 34, contextWindow: 4096, truncated: false, finishReason: "stop" }),
    "1,200 input + 34 output · 1,234/4,096 context (30%) · stop",
  );
});

test("formats verbose operational diagnostics without prompt contents", () => {
  assert.equal(
    formatVerboseDiagnostics({ systemPromptChars: 3200, taskPromptChars: 5100, projectContextChars: 4200, transcriptChars: 300, responseFormat: "structured" }),
    "3,200 system + 5,100 task chars · 4,200 project context · 300 transcript · structured",
  );
});
