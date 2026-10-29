# cmd-ai

`cmd-ai` is a deliberately small shell agent for Apple Silicon Macs. It uses
Apple's on-device Foundation Model through
[`@dangayle/applepi`](https://pi.dev/packages/@dangayle/applepi), so prompts and
command output stay on your Mac and no API key is needed.

```sh
cmd-ai "read all the files in the folder and find the same ones"
```

The equivalent `ai-cmd` name is also installed.

It starts in your current directory, asks Apple Intelligence for one structured
shell action, and runs it. A shell action can contain a pipeline or several
commands, keeping the usual path to one fast local-model call.

While it works, the terminal shows the current phase, elapsed planning time, a
bounded 1–4 step public planning trace, a short decision rationale, expected
command impact, the exact command, permission decision, and its exit status. It
does not expose raw hidden chain-of-thought or system instructions.

For project questions, the CLI supplies a verified top-level inventory and
bounded excerpts from standard metadata such as `README.md` and `package.json`.
This lets the local model answer from evidence without inventing filenames or
running redundant inspection commands.

## Requirements

- Apple Silicon (M1 or newer)
- macOS 26 or newer
- Apple Intelligence enabled in System Settings
- Node.js 22.19 or newer
- Xcode Command Line Tools (`xcode-select --install`)
- pnpm (`corepack enable` if needed)

## Install

```sh
pnpm install
pnpm run bootstrap
npm link
```

The setup command compiles `applepi`'s small Swift bridge once and verifies that
the on-device model is available. Then run `cmd-ai` from any folder:

```sh
cd ~/Documents/receipts
cmd-ai "find exact duplicate files"
```

Commands are printed before execution. Read-only commands are automatically
allowed by default; changing commands ask for Y/N confirmation. Use `--yes` to
skip those prompts for one run only when you trust the request and folder:

```sh
cmd-ai --yes "create a sorted list of every PDF in files.txt"
```

Preview only the first proposed command without running it:

```sh
cmd-ai --dry-run "rename the photos by date"
```

For a task that genuinely needs inspection followed by another action, opt into
a short agent loop. Command results are fed back to the model between steps:

```sh
cmd-ai --max-steps 4 "inspect this project and fix its failing test"
```

Run `cmd-ai --help` for all options.

## Built-in runtime tools

The system prompt advertises two first-class command tools available on macOS:

- `git` for repository inspection and explicitly requested version-control work.
  Status, logs, diffs, and other inspections run as read-only; repository changes
  require permission.
- `curl` for HTTP(S) retrieval and API calls. GET/HEAD responses written to the
  terminal are read-only; downloads, uploads, request bodies, and mutating methods
  require permission.

These are shell-backed capabilities rather than native Apple Intelligence tool
calls, so every proposed command still passes through the normal permission UI.

## Configuration and permissions

On every run, `cmd-ai` checks `~/.cmd-ai/config`, then `config.yml` or
`config.yaml`. The file is YAML. With no file, the built-in `readonly` policy is
used: read-only commands run automatically and commands expected to make changes
require confirmation. Commands matched by `deny` remain blocked and cannot be
approved interactively.

```yaml
permissions:
  # readonly or dangerous
  mode: readonly

  # Whole-command glob patterns. deny always wins.
  allow:
    - "git status*"
    - "mkdir ./generated*"
  deny:
    - "rm *"
    - "sudo *"

status:
  # Disabled by default. Shows model tokens and context use after each plan.
  show_model_usage: false
  # Disabled by default. Shows runtime and prompt/result diagnostics.
  verbose: false

# Appended to the built-in system prompt.
prompt: |
  Keep answers terse.
  Prefer rg over grep when both are available.
```

Permission order is: `deny` → `allow` → one-run `--yes`/`--dangerous` override → configured
mode → read-only default. `dangerous` mode automatically allows any command not
matched by `deny`; use it carefully. All commands still run with your user
permissions and are not sandboxed.

Set `status.show_model_usage` to `true` to display Apple bridge usage metadata
after every planning step:

```text
Tokens    1,200 input + 34 output · 1,234/4,096 context (30%) · stop
```

The bridge may report zero output tokens for some structured responses; cmd-ai
shows the values as received rather than estimating them.

Set `status.verbose` to `true` for additional operational details: active shell
and built-in tools, command limit, system/task prompt sizes, project-context and
transcript sizes, structured-versus-fallback response format, and captured
command-output size. Verbose mode never prints the system prompt or private
model reasoning.

## User tools and skills

Put tool definitions in `~/.cmd-ai/tools` and skills in `~/.cmd-ai/skills`.
Supported files are `.md`, `.yaml`, `.yml`, and `.json`. They are loaded in name
order with a bounded context budget.

Example `~/.cmd-ai/tools/changelog.yml`:

```yaml
name: changelog
description: Summarize commits since the last tag.
command: git log "$(git describe --tags --abbrev=0)..HEAD" --oneline
read_only: true
```

Tool files are instructions for the local model. Give each tool a clear name,
purpose, command or usage pattern, and whether it is expected to be read-only.
The model turns a relevant definition into a visible shell command, which is
then evaluated by the normal permission policy.

Example `~/.cmd-ai/skills/release-notes.md`:

```markdown
# Release notes

When asked for release notes, use the changelog tool and group the result into
features, fixes, and maintenance.
```

Skills receive the loaded tool definitions, so they can name and use those
tools—including a user-defined tool that creates new skill files. The resulting
shell command must still pass the same permission policy; writing under
`~/.cmd-ai/skills` therefore needs an `allow` pattern, `--yes`, or dangerous
mode.

## Design

There is no server, database, API key, or application framework. The Node CLI is
only an orchestration loop. It calls `applepi`'s local Swift bridge for a JSON
action and executes it with `/bin/zsh` in the invocation directory. Multi-step
runs keep a small rolling transcript to fit Apple's 4096-token context window.
An identical command is never executed twice in one run.

`applepi`'s Pi provider is text-only and does not emit tool calls, so this CLI
uses the same package's bridge directly for structured action generation.

## Safety

The generated commands run with your normal user permissions and are not
sandboxed. Review the displayed command and permission decision. Keep readonly
mode for unfamiliar folders or tasks, answer confirmation prompts carefully,
and back up important data before bulk edits.
