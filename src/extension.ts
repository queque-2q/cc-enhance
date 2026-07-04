import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DiffManager } from './DiffManager';
import { WebviewProvider } from './WebviewProvider';
import { HooksManager } from './HooksManager';

let diffManager: DiffManager;
let webviewProvider: WebviewProvider;
let hooksManager: HooksManager;
let fileWatcher: vscode.FileSystemWatcher | undefined;
let changeListener: vscode.Disposable | undefined;

/** Shared output channel for logging all extension activity. */
let outputChannel: vscode.OutputChannel;

/** Write a timestamped message to the shared output channel. */
function log(msg: string): void {
  const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
  outputChannel.appendLine(`[${ts}] ${msg}`);
}

/**
 * The VSCode workspace folder IS the Claude Code project root.
 * Hooks write to <cwd>/.claude/cc-diff/patches/, and cwd equals
 * the workspace folder path.
 */
function findClaudeProjectRoot(workspaceFolder: string): string {
  return path.resolve(workspaceFolder);
}

export function activate(context: vscode.ExtensionContext): void {
  // Determine workspace root
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return; // No workspace open — nothing to do
  }

  // Walk up from the VSCode workspace folder to find .claude/cc-diff/
  const workspaceRoot = findClaudeProjectRoot(workspaceFolders[0].uri.fsPath);

  // ── Output channel ──
  outputChannel = vscode.window.createOutputChannel('CC Diff', { log: true });
  context.subscriptions.push(outputChannel);
  log(`Extension activated — workspace: ${workspaceRoot}`);
  log(`Extension path: ${context.extensionPath}`);

  // ── Hooks auto-update ──
  hooksManager = new HooksManager(context.extensionPath);
  hooksManager.setLogger(log);
  log('Checking hook scripts for updates...');
  hooksManager.autoUpdate(workspaceRoot);

  // ── DiffManager ──
  diffManager = new DiffManager();
  diffManager.setLogger(log);
  diffManager.setConflictHandler((file: string, hunkId: number | undefined, detail: string) => {
    const label = hunkId !== undefined
      ? `${file} (hunk ${hunkId})`
      : file;
    log(`[POPUP] Conflict dialog shown for "${label}"`);
    vscode.window.showErrorMessage(
      `CC Diff: git apply --reverse 冲突 — ${label}\n\n${detail}`,
      { modal: false }
    );
  });
  diffManager.setWorkspaceRoot(workspaceRoot);
  diffManager.loadPatches(workspaceRoot);

  // Debug: dump state to file for diagnosis
  (() => {
    try {
      const allPatches = diffManager.getAllPatches();
      const allFiles = diffManager.getAllFiles();
      const dump = {
        workspaceRoot,
        patchesDir: path.join(workspaceRoot, '.claude', 'cc-diff', 'patches'),
        patchesDirExists: fs.existsSync(path.join(workspaceRoot, '.claude', 'cc-diff', 'patches')),
        indexExists: fs.existsSync(path.join(workspaceRoot, '.claude', 'cc-diff', 'patches', 'index.json')),
        patchCount: allPatches.length,
        fileCount: allFiles.length,
        patches: allPatches.map(p => ({
          id: p.id,
          sessionId: p.sessionId,
          timestamp: p.timestamp,
          file: p.file,
          hunks: p.hunks.length,
          status: p.status,
        })),
      };
      fs.writeFileSync(
        path.join(workspaceRoot, '.claude', 'cc-diff', '.debug-load.json'),
        JSON.stringify(dump, null, 2),
        'utf8'
      );
    } catch {}
  })();

  // ── WebviewProvider ──
  webviewProvider = new WebviewProvider(workspaceRoot, diffManager, outputChannel);

  // ── Sidebar webview ──
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('cc-diff.view', webviewProvider)
  );

  // ── File watcher: patches/index.json ──
  const watchPattern = new vscode.RelativePattern(
    workspaceFolders[0],
    '.claude/cc-diff/patches/index.json'
  );

  fileWatcher = vscode.workspace.createFileSystemWatcher(watchPattern, false, false, false);
  context.subscriptions.push(fileWatcher);

  fileWatcher.onDidCreate((uri) => {
    log(`FileWatcher: index.json created — ${uri.fsPath}`);
    diffManager.loadPatches(workspaceRoot);
    // Consolidate all tracked files after new patches arrive
    for (const f of diffManager.getAllFiles()) {
      diffManager.consolidatePatches(f, workspaceRoot);
    }
    webviewProvider.refresh();
    // Auto-focus: new patches just arrived via Stop hook
    if (diffManager.getAllPatches().length > 0) {
      vscode.commands.executeCommand('cc-diff.view.focus');
      log('FileWatcher: auto-focused cc-diff view (new patches)');
    }
  });

  fileWatcher.onDidChange((uri) => {
    const before = diffManager.getAllPatches().length;
    log(`FileWatcher: index.json changed — ${uri.fsPath}`);
    diffManager.loadPatches(workspaceRoot);
    // Consolidate all tracked files after new patches arrive
    for (const f of diffManager.getAllFiles()) {
      diffManager.consolidatePatches(f, workspaceRoot);
    }
    webviewProvider.refresh();
    const after = diffManager.getAllPatches().length;
    // Auto-focus only when new patches were added (count increased),
    // not when patches are processed/removed via accept/deny.
    if (after > before) {
      vscode.commands.executeCommand('cc-diff.view.focus');
      log(`FileWatcher: auto-focused cc-diff view (patches: ${before} → ${after})`);
    }
  });

  fileWatcher.onDidDelete((uri) => {
    log(`FileWatcher: index.json deleted — ${uri.fsPath}`);
    diffManager.loadPatches(workspaceRoot);
    webviewProvider.refresh();
  });

  // ── Text document change listener ──
  changeListener = vscode.workspace.onDidChangeTextDocument((e) => {
    if (e.document.uri.scheme !== 'file') return;
    const relativePath = vscode.workspace.asRelativePath(e.document.uri);
    webviewProvider.notifyFileChanged(relativePath);
  });
  context.subscriptions.push(changeListener);

  // ── Status bar ──
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  statusBarItem.command = 'cc-diff.focus';
  statusBarItem.text = '$(diff) CC Diff';
  statusBarItem.tooltip = 'Show CC Diff panel';
  context.subscriptions.push(statusBarItem);
  statusBarItem.show();

  // ── Commands ──
  context.subscriptions.push(
    vscode.commands.registerCommand('cc-diff.focus', () => {
      vscode.commands.executeCommand('cc-diff.view.focus');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cc-diff.setupHooks', async () => {
      log('Command: setupHooks invoked');
      try {
        await hooksManager.setupHooks(workspaceRoot);
        log('Command: setupHooks succeeded');
        vscode.window.showInformationMessage(
          'CC Diff: Hook 脚本安装成功！请查看 .claude/settings.json'
        );
      } catch (err: any) {
        log(`Command: setupHooks FAILED — ${err.message}`);
        vscode.window.showErrorMessage(`CC Diff: Hook 安装失败 — ${err.message}`);
      }
    })
  );

  log('Activation complete.');
}

export function deactivate(): void {
  log('Extension deactivated.');
  if (fileWatcher) {
    fileWatcher.dispose();
  }
  if (changeListener) {
    changeListener.dispose();
  }
}
