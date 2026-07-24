# cc-diff

[English](README.md) | [中文](README.zh-CN.md)

VSCode extension — displays file diffs after Claude Code conversations, with file-level and hunk-level Accept/Deny controls, similar to Copilot's diff feature.

## Project Structure

```
cc-diff/
├── hooks/                    # Claude Code Hook scripts
│   ├── pre-tool-use.js       # PreToolUse hook: save file snapshots before edits
│   └── session-end.js        # SessionEnd hook: verify tracked files on session end
├── src/
│   ├── extension.ts      # Extension entry point
│   ├── DiffManager.ts    # Core state management: load patches, Accept/Deny, reverse git apply
│   ├── WebviewProvider.ts # Sidebar webview UI
│   └── types/
│       └── diff.d.ts     # TypeScript type declarations for the diff package
├── out/                  # Compiled output
├── package.json          # Extension manifest
├── tsconfig.json         # TypeScript config
├── test/
│   └── integration-test.sh   # Hooks integration test script
└── docs/
    └── superpowers/
        ├── specs/2026-07-03-cc-diff-design.md   # Design document
        └── plans/2026-07-03-cc-diff.md            # Implementation plan
```

## Installation

### 1. Configure Claude Code Hooks

Add to your project's `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/cc-diff/hooks/pre-tool-use.js",
            "timeout": 10000
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/cc-diff/hooks/session-end.js",
            "timeout": 30000
          }
        ]
      }
    ]
  }
}
```

### 2. Install the VSCode Extension

```bash
cd vscode-extension
npm install
npm run compile
```

Then copy or symlink the `vscode-extension` directory to the VSCode extensions directory:
- Windows: `%USERPROFILE%\.vscode\extensions\cc-diff`
- Mac/Linux: `~/.vscode/extensions/cc-diff`

### 3. Reload VSCode

Select "Developer: Reload Window" from the command palette.

## Usage

### First-Time Setup

Run the **CC Diff: Install Hook Scripts** command from the Command Palette (`Ctrl+Shift+P`). This automatically deploys and configures the Claude Code hook scripts for your workspace.

### Daily Use

1. Start a Claude Code session and let it edit files
2. On session end, the "CC Diff" icon appears in the VSCode activity bar
3. Click the icon to open the sidebar — all changed files are listed with Accept/Deny controls
4. Click a file to open the Monaco Diff Editor (split or unified view)
5. Use the toolbar buttons or command palette to accept/deny changes per file or in bulk

## Commands

All commands are available via the Command Palette (`Ctrl+Shift+P`) under the **CC Diff** category:

| Command | Title | Description |
| --- | --- | --- |
| `cc-diff.setupHooks` | **Install Hook Scripts** | Deploy and configure Claude Code hook scripts (`pre-tool-use.js`, `session-end.js`) for the current workspace |
| `cc-diff.acceptAllFileEditor` | **Accept All** | Accept all changes in the current file (visible in the Monaco Diff Editor) |
| `cc-diff.denyAllFileEditor` | **Deny All** | Revert all changes in the current file (visible in the Monaco Diff Editor) |
| `cc-diff.prevHunk` | **Previous Hunk** | Navigate to the previous diff hunk |
| `cc-diff.nextHunk` | **Next Hunk** | Navigate to the next diff hunk |
| `cc-diff.toggleDiffMode` | **Toggle Diff Mode** | Switch between unified (inline) and split (side-by-side) diff views |
| `cc-diff.openCurrentFile` | **Open File** | Open the current file in the VSCode editor |

The **Toggle Diff Mode** and **Open File** commands also appear as toolbar buttons in the Monaco Diff Editor title bar.

## Workflow

```
Claude Code edits files → PreToolUse Hook saves snapshot
                              ↓
                        Session ends
                              ↓
           SessionEnd Hook verifies tracked files → writes patch JSON
                              ↓
              VSCode extension detects index.json
                              ↓
                Webview sidebar displays all changes
                              ↓
       Click filename → VSCode Diff Editor (left: before, right: current)
                              ↓
        Accept All / Deny per-file / manual edits update in real time
```

## Data Storage

All diff data is stored under `<project>/.claude/cc-diff/`:

- `patches/index.json` — global manifest with all patches, sorted by timestamp
- `patches/<timestamp>-<sessionId>-<safeFile>.patch.json` — individual file patches (flat storage)
- `snapshots/` — file snapshots for pre-edit state

Completed sessions are automatically cleaned up after 24 hours.

## Tech Stack

| Component | Technology |
|-----------|------------|
| Hook Scripts | Node.js CJS, `git diff --no-index` |
| VSCode Extension | TypeScript, VSCode Extension API |
| Webview UI | HTML + CSS + Vanilla JS (all colors use VSCode CSS variables) |
| Diff Computation | `git diff --no-index` |
| Deny Operation | `git apply --unidiff-zero --reverse` |
| Build | `tsc` |
