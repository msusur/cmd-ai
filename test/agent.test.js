import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACTION_SCHEMA,
  appendTranscript,
  buildProjectContext,
  classifyCommandImpact,
  parseModelJson,
  trimEnd,
  trimStart,
  validateAction,
} from "../src/agent.js";

test("structured actions prefer answering from evidence before running a command", () => {
  assert.deepEqual(ACTION_SCHEMA.properties.action.enum, ["done", "run"]);
});

test("validates run actions", () => {
  assert.deepEqual(validateAction({ action: "run", command: "  pwd  ", message: "look" }), {
    action: "run",
    command: "pwd",
    message: "look",
    impact: "read-only",
  });
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
});

test("rejects an empty command", () => {
  assert.throws(() => validateAction({ action: "run", command: "", message: "" }), /empty command/);
});

test("repairs a shell backslash in prompt-generated JSON", () => {
  const action = parseModelJson('{"action":"run","command":"find . -exec echo {} \\;","message":""}');
  assert.equal(action.command, "find . -exec echo {} \\;");
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
