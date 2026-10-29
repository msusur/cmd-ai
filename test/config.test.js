import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildExtensionPrompt, evaluatePermission, loadConfig, matchesCommandPattern } from "../src/config.js";

test("loads YAML config, tools, and skills", async () => {
  const folder = await mkdtemp(join(tmpdir(), "cmd-ai-config-"));
  try {
    await mkdir(join(folder, "tools"));
    await mkdir(join(folder, "skills"));
    await writeFile(
      join(folder, "config"),
      "permissions:\n  mode: dangerous\n  allow: ['git *']\n  deny: ['rm *']\nprompt: Answer briefly.\n",
    );
    await writeFile(join(folder, "tools", "summary.yml"), "name: summary\ndescription: Summarize text\n");
    await writeFile(join(folder, "skills", "review.md"), "# Review\nUse the summary tool.\n");

    const settings = await loadConfig(folder);
    assert.equal(settings.permissions.mode, "dangerous");
    assert.deepEqual(settings.permissions.deny, ["rm *"]);
    assert.equal(settings.tools.length, 1);
    assert.equal(settings.skills.length, 1);
    assert.match(buildExtensionPrompt(settings), /Answer briefly/);
    assert.match(buildExtensionPrompt(settings), /Use the summary tool/);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("permission precedence is deny, allow, override, mode, then readonly default", () => {
  const readonly = { mode: "readonly", allow: ["mkdir safe*"], deny: ["rm *"] };
  assert.equal(evaluatePermission("ls", "read-only", readonly).allowed, true);
  assert.equal(evaluatePermission("mkdir safe-folder", "writes-files", readonly).allowed, true);
  assert.equal(evaluatePermission("touch file", "writes-files", readonly).allowed, false);
  assert.equal(evaluatePermission("rm file", "writes-files", readonly, true).allowed, false);
  assert.equal(evaluatePermission("touch file", "writes-files", readonly, true).allowed, true);

  const dangerous = { mode: "dangerous", allow: [], deny: ["rm *"] };
  assert.equal(evaluatePermission("touch file", "writes-files", dangerous).allowed, true);
  assert.equal(evaluatePermission("rm file", "writes-files", dangerous).allowed, false);
});

test("command patterns are whole-command globs", () => {
  assert.equal(matchesCommandPattern("git status --short", "git status*"), true);
  assert.equal(matchesCommandPattern("echo git status", "git status*"), false);
});
