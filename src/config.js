import { homedir } from "node:os";
import { extname, join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

const RESOURCE_EXTENSIONS = new Set([".md", ".yaml", ".yml", ".json"]);
const MAX_RESOURCE_CHARS = 2_000;
const MAX_EXTENSION_PROMPT_CHARS = 5_000;

function stringList(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be a YAML list of strings.`);
  }
  return value;
}

async function loadResourceDirectory(directory, kind) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const resources = [];
  let usedChars = 0;
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !RESOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
    const content = await readFile(join(directory, entry.name), "utf8");
    const remaining = MAX_RESOURCE_CHARS - usedChars;
    if (remaining <= 0) break;
    const excerpt = content.slice(0, remaining);
    resources.push({ kind, name: entry.name, content: excerpt });
    usedChars += excerpt.length;
  }
  return resources;
}

export async function loadConfig(baseDirectory = process.env.CMD_AI_HOME || join(homedir(), ".cmd-ai")) {
  const candidates = ["config", "config.yml", "config.yaml"];
  let configPath = null;
  let raw = {};

  for (const name of candidates) {
    const path = join(baseDirectory, name);
    try {
      raw = parseYaml(await readFile(path, "utf8")) ?? {};
      configPath = path;
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error(`Could not read ${path}: ${error.message}`);
    }
  }

  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("cmd-ai config must contain a YAML mapping.");
  }

  const permissionConfig = raw.permissions ?? {};
  if (typeof permissionConfig !== "object" || Array.isArray(permissionConfig)) {
    throw new Error("permissions must be a YAML mapping.");
  }
  const mode = permissionConfig.mode ?? "readonly";
  if (!['readonly', 'dangerous'].includes(mode)) {
    throw new Error('permissions.mode must be "readonly" or "dangerous".');
  }

  const statusConfig = raw.status ?? {};
  if (typeof statusConfig !== "object" || Array.isArray(statusConfig)) {
    throw new Error("status must be a YAML mapping.");
  }
  const showModelUsage = statusConfig.show_model_usage ?? false;
  if (typeof showModelUsage !== "boolean") {
    throw new Error("status.show_model_usage must be true or false.");
  }
  const verbose = statusConfig.verbose ?? false;
  if (typeof verbose !== "boolean") {
    throw new Error("status.verbose must be true or false.");
  }

  const prompt = raw.prompt ?? raw.system_prompt ?? "";
  if (typeof prompt !== "string") throw new Error("prompt must be a string.");

  const [tools, skills] = await Promise.all([
    loadResourceDirectory(join(baseDirectory, "tools"), "tool"),
    loadResourceDirectory(join(baseDirectory, "skills"), "skill"),
  ]);

  return {
    baseDirectory,
    configPath,
    prompt,
    permissions: {
      mode,
      allow: stringList(permissionConfig.allow, "permissions.allow"),
      deny: stringList(permissionConfig.deny, "permissions.deny"),
    },
    status: { showModelUsage, verbose },
    tools,
    skills,
  };
}

export function buildExtensionPrompt(settings) {
  const sections = [];
  if (settings.prompt.trim()) {
    sections.push(`User instructions from ${settings.configPath ?? "cmd-ai config"}:\n${settings.prompt.trim()}`);
  }
  if (settings.tools.length > 0) {
    const tools = settings.tools.map((tool) => `Tool definition (${tool.name}):\n${tool.content}`).join("\n\n");
    sections.push(`User-defined tools from ${join(settings.baseDirectory, "tools")} are available below. Skills may reference these tools. Commands remain subject to the permission policy.\n${tools}`);
  }
  if (settings.skills.length > 0) {
    const skills = settings.skills.map((skill) => `Skill (${skill.name}):\n${skill.content}`).join("\n\n");
    sections.push(`User-defined skills from ${join(settings.baseDirectory, "skills")} are below. Follow a skill when it is relevant to the task; a skill may use any listed user tool. When asked to create a skill, use relevant tools and write the new definition only under this skills directory, subject to the permission policy.\n${skills}`);
  }
  return sections.join("\n\n").slice(0, MAX_EXTENSION_PROMPT_CHARS);
}

export function matchesCommandPattern(command, pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "s").test(command);
}

export function evaluatePermission(command, impact, permissions, oneRunDangerous = false) {
  const deniedBy = permissions.deny.find((pattern) => matchesCommandPattern(command, pattern));
  if (deniedBy) return { allowed: false, requiresConfirmation: false, reason: `denied by pattern: ${deniedBy}` };

  const allowedBy = permissions.allow.find((pattern) => matchesCommandPattern(command, pattern));
  if (allowedBy) return { allowed: true, requiresConfirmation: false, reason: `allowed by pattern: ${allowedBy}` };
  if (oneRunDangerous) return { allowed: true, requiresConfirmation: false, reason: "one-run dangerous override (--yes)" };
  if (permissions.mode === "dangerous") return { allowed: true, requiresConfirmation: false, reason: "dangerous mode" };
  if (impact === "read-only") return { allowed: true, requiresConfirmation: false, reason: "read-only default" };
  return { allowed: false, requiresConfirmation: true, reason: `${impact} command requires confirmation in readonly mode` };
}
