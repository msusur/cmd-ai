#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { stdout, stderr } from "node:process";
import { fileURLToPath } from "node:url";
import {
  appendTranscript,
  askModel,
  checkAppleIntelligence,
  ensureBridge,
  runCommand,
} from "./agent.js";
import { buildExtensionPrompt, evaluatePermission, loadConfig } from "./config.js";

const HELP = `cmd-ai — a tiny local command-line agent powered by Apple Intelligence

Usage:
  cmd-ai "read all files in this folder and find duplicates"
  cmd-ai --yes "rename all .jpeg files to .jpg"

Options:
  -y, --yes, --dangerous
                     Allow non-denied commands for this run
  -n, --dry-run      Print the first proposed command without running it
      --max-steps N  Allow up to N commands (default: 1)
      --check        Check whether Apple Intelligence is available
      --setup        Build the local Swift bridge and check availability
  -h, --help         Show this help

The agent always operates in the directory from which you invoke cmd-ai.
Default policy runs read-only commands and blocks changes. Configure ~/.cmd-ai/config.`;

const colorEnabled = Boolean(stderr.isTTY && !process.env.NO_COLOR);
const paint = (code, text) => (colorEnabled ? `\x1b[${code}m${text}\x1b[0m` : text);
const label = (text) => paint("2", text.padEnd(9));
const formatSeconds = (startedAt) => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;

function showRunHeader(prompt, cwd, settings) {
  stderr.write(`${paint("1;36", "cmd-ai")} ${paint("2", "· Apple Intelligence · on-device")}\n`);
  stderr.write(`${label("Task")} ${prompt}\n`);
  stderr.write(`${label("Folder")} ${cwd}\n`);
  stderr.write(`${label("Policy")} ${settings.permissions.mode} · ${settings.configPath ?? "built-in defaults"}\n`);
  if (settings.tools.length || settings.skills.length) {
    stderr.write(`${label("Loaded")} ${settings.tools.length} tool(s) · ${settings.skills.length} skill(s)\n`);
  }
  stderr.write("\n");
}

function startSpinner(text) {
  const startedAt = Date.now();
  if (!stderr.isTTY) {
    stderr.write(`${text}...\n`);
    return () => {};
  }

  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let frame = 0;
  const render = () => {
    stderr.write(`\r\x1b[2K${paint("36", frames[frame++ % frames.length])} ${text} ${paint("2", formatSeconds(startedAt))}`);
  };
  render();
  const timer = setInterval(render, 80);
  return () => {
    clearInterval(timer);
    stderr.write("\r\x1b[2K");
  };
}

function showProposal(action, step, maxSteps) {
  if (maxSteps > 1) stderr.write(`${label("Step")} ${step}/${maxSteps}\n`);
  stderr.write(`${label("Plan")} ${action.message || "Run the proposed command."}\n`);
  stderr.write(`${label("Impact")} ${action.impact}\n`);
  stderr.write(`\n${paint("1", "$")} ${action.command}\n`);
}

export function parseArgs(argv) {
  const options = { yes: false, dryRun: false, maxSteps: 1, check: false, setup: false, help: false };
  const prompt = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-y" || arg === "--yes" || arg === "--dangerous") options.yes = true;
    else if (arg === "-n" || arg === "--dry-run") options.dryRun = true;
    else if (arg === "--check") options.check = true;
    else if (arg === "--setup") options.setup = true;
    else if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "--max-steps") {
      const value = Number.parseInt(argv[++i], 10);
      if (!Number.isInteger(value) || value < 1 || value > 50) {
        throw new Error("--max-steps must be an integer from 1 to 50.");
      }
      options.maxSteps = value;
    } else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else prompt.push(arg);
  }

  return { ...options, prompt: prompt.join(" ").trim() };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }
  if (args.check || args.setup) {
    const status = await checkAppleIntelligence();
    if (!status.available) throw new Error(status.reason || "Apple Intelligence is unavailable.");
    console.log("Apple Intelligence is available. cmd-ai is ready.");
    return;
  }
  if (!args.prompt) {
    console.log(HELP);
    process.exitCode = 1;
    return;
  }

  const cwd = process.cwd();
  const settings = await loadConfig();
  const extensionPrompt = buildExtensionPrompt(settings);
  const bridge = await ensureBridge();
  let transcript = "";
  const seenCommands = new Set();
  showRunHeader(args.prompt, cwd, settings);

  for (let step = 1; step <= args.maxSteps; step += 1) {
    const planningLabel = args.maxSteps > 1 ? `Planning step ${step}/${args.maxSteps} locally` : "Planning locally";
    const stopSpinner = startSpinner(planningLabel);
    let action;
    try {
      action = await askModel({ goal: args.prompt, transcript, cwd, bridge, extensionPrompt });
    } finally {
      stopSpinner();
    }

    if (action.action === "done") {
      stderr.write(`${paint("32", "✓")} Done\n`);
      console.log(action.message || "Done.");
      return;
    }

    showProposal(action, step, args.maxSteps);
    const permission = evaluatePermission(action.command, action.impact, settings.permissions, args.yes);
    const permissionWord = permission.allowed ? paint("32", "allowed") : paint("31", "blocked");
    stderr.write(`${label("Permission")} ${permissionWord} · ${permission.reason}\n`);
    if (args.dryRun) {
      stderr.write(`${label("Status")} Dry run; nothing executed.\n`);
      return;
    }

    if (seenCommands.has(action.command)) {
      process.stderr.write("Stopped because the model proposed the same command twice.\n");
      return;
    }

    if (!permission.allowed) {
      stderr.write(`${label("Status")} Command was not executed.\n`);
      process.exitCode = 2;
      return;
    }

    const startedAt = Date.now();
    stderr.write(`${label("Status")} Running...\n`);
    let outputEndsWithNewline = true;
    const result = await runCommand(action.command, {
      cwd,
      onOutput: (text) => {
        outputEndsWithNewline = text.endsWith("\n");
        process.stdout.write(text);
      },
    });
    if (!outputEndsWithNewline) stdout.write("\n");
    const statusIcon = result.code === 0 ? paint("32", "✓") : paint("31", "✗");
    stderr.write(`${statusIcon} Finished · exit ${result.code} · ${formatSeconds(startedAt)}\n`);
    seenCommands.add(action.command);
    transcript = appendTranscript(transcript, action.command, result);
    if (step === args.maxSteps) {
      if (result.code !== 0) throw new Error(`Command exited with status ${result.code}.`);
      return;
    }
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`cmd-ai: ${error.message}`);
    process.exitCode = 1;
  });
}
