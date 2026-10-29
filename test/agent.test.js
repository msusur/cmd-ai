import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACTION_SCHEMA,
  BUILTIN_RUNTIME_TOOLS,
  appendTranscript,
  buildProjectContext,
  buildSystemPrompt,
  classifyCommandImpact,
  extractUserPaths,
  normalizePublicPlan,
  normalizeModelUsage,
  parseModelJson,
  trimEnd,
  trimStart,
  validateAction,
} from "../src/agent.js";

test("builds a runtime-aware system prompt for the active folder", () => {
  const prompt = buildSystemPrompt({ cwd: "/tmp/example workspace" });
  assert.match(prompt, /Working directory: "\/tmp\/example workspace"/);
  assert.match(prompt, /Every command starts in the working directory above/);
  assert.match(prompt, /Preserve every path supplied by the user exactly/);
  assert.match(prompt, /~\/\.cmd-ai\/config/);
  assert.doesNotMatch(prompt, /~\/cmd-helper\/config\.yml/);
  assert.match(prompt, /git \(\/usr\/bin\/git\)/);
  assert.match(prompt, /curl \(\/usr\/bin\/curl\)/);
  assert.deepEqual(BUILTIN_RUNTIME_TOOLS.map((tool) => tool.name), ["git", "curl"]);
});

test("keeps user prompt extensions subordinate to runtime and permission rules", () => {
  const prompt = buildSystemPrompt({ cwd: "/tmp/project", extensionPrompt: "Prefer JSON output." });
  assert.match(prompt, /# User extensions/);
  assert.match(prompt, /Prefer JSON output\./);
  assert.ok(prompt.indexOf("# Runtime") < prompt.indexOf("# User extensions"));
  assert.match(prompt, /external permission policy/);
});

test("extracts exact absolute and home-relative paths from the task", () => {
  assert.deepEqual(
    extractUserPaths("read /Users/me/project/config.example.yml, then write ~/.cmd-ai/config"),
    ["/Users/me/project/config.example.yml", "~/.cmd-ai/config"],
  );
});

test("structured actions prefer answering from evidence before running a command", () => {
  assert.deepEqual(ACTION_SCHEMA.properties.action.enum, ["done", "run"]);
});

test("normalizes usage metadata from the Apple bridge", () => {
  assert.deepEqual(normalizeModelUsage({ prompt_tokens: 1200, completion_tokens: 34, context_size: 4096, truncated: true, finish_reason: "length" }), {
    inputTokens: 1200,
    outputTokens: 34,
    contextWindow: 4096,
    truncated: true,
    finishReason: "length",
  });
});

test("validates run actions", () => {
  assert.deepEqual(validateAction({ action: "run", command: "  pwd  ", message: "look", plan: "Inspect the folder\nReport the path" }), {
    action: "run",
    command: "pwd",
    message: "look",
    plan: ["Inspect the folder", "Report the path"],
    impact: "read-only",
  });
});

test("bounds and cleans the public planning trace", () => {
  assert.deepEqual(normalizePublicPlan("1. Inspect files\n- Choose a command\n3) Check policy\nRun it\nIgnore extra"), [
    "Inspect files",
    "Choose a command",
    "Check policy",
    "Run it",
  ]);
});

test("classifies command impact conservatively", () => {
  assert.equal(classifyCommandImpact("cat README.md"), "read-only");
  assert.equal(classifyCommandImpact("ls | sort"), "read-only");
  assert.equal(classifyCommandImpact("find . -type f -exec shasum {} \\; | sort"), "read-only");
  assert.equal(classifyCommandImpact("rm old.txt"), "writes-files");
  assert.equal(classifyCommandImpact("ls; node write.js"), "writes-files");
  assert.equal(classifyCommandImpact("echo $(touch file)"), "writes-files");
  assert.equal(classifyCommandImpact("find . -type f -exec rm {} \\;"), "writes-files");
  assert.equal(classifyCommandImpact("sudo launchctl kickstart system/foo"), "system-change");
  assert.equal(classifyCommandImpact("node unknown-script.js"), "writes-files");
  assert.equal(classifyCommandImpact("git status --short"), "read-only");
  assert.equal(classifyCommandImpact("git rev-parse --show-toplevel"), "read-only");
  assert.equal(classifyCommandImpact("git branch feature"), "writes-files");
  assert.equal(classifyCommandImpact("git push origin main"), "writes-files");
  assert.equal(classifyCommandImpact("curl -fsSL https://example.com"), "read-only");
  assert.equal(classifyCommandImpact("curl -fsSL -o result.json https://example.com"), "writes-files");
  assert.equal(classifyCommandImpact("curl -X POST https://example.com"), "writes-files");
});

test("rejects an empty command", () => {
  assert.throws(() => validateAction({ action: "run", command: "", message: "" }), /empty command/);
});

test("repairs a shell backslash in prompt-generated JSON", () => {
  const action = parseModelJson('{"action":"run","command":"find . -exec echo {} \\;","message":""}');
  assert.equal(action.command, "find . -exec echo {} \\;");
});

test("accepts Apple Intelligence key-value fallback output", () => {
  const action = parseModelJson('action=run\ncommand="ls"\nmessage="Inspect files"\nplan="List entries\\nReport findings"');
  assert.deepEqual(action, {
    action: "run",
    command: "ls",
    message: "Inspect files",
    plan: "List entries\nReport findings",
  });
});

test("accepts loose key-value output when Apple omits the public plan", () => {
  const action = parseModelJson("- Action: run\n- Command: cat /tmp/example.yml\n- Message: Read the example");
  assert.deepEqual(action, {
    action: "run",
    command: "cat /tmp/example.yml",
    message: "Read the example",
    plan: "Read the example",
  });
});

test("truncates context from the beginning", () => {
  assert.match(trimStart("abcdefgh", 4), /efgh$/);
});

test("truncates command output from the end", () => {
  assert.match(trimEnd("abcdefgh", 4), /^abcd/);
});

test("records command status and output", () => {
  const transcript = appendTranscript("", "pwd", { code: 0, output: "/tmp\n", timedOut: false });
  assert.match(transcript, /\$ pwd/);
  assert.match(transcript, /\[exit 0\]/);
  assert.match(transcript, /\/tmp/);
});

test("project context contains verified names and standard metadata", async () => {
  const folder = await mkdtemp(join(tmpdir(), "cmd-ai-context-"));
  try {
    await writeFile(join(folder, "README.md"), "# Example\nA verified project purpose.\n");
    await writeFile(join(folder, "package.json"), '{"name":"example"}\n');
    const context = await buildProjectContext(folder);
    assert.match(context, /Verified top-level entries:/);
    assert.match(context, /README\.md/);
    assert.match(context, /A verified project purpose/);
    assert.match(context, /"name":"example"/);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
