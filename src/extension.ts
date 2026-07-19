import * as path from 'path';
import * as vscode from 'vscode';
import { SnapshotManager } from './SnapshotManager';
import { WebviewProvider } from './WebviewProvider';
import { MonacoDiffProvider } from './MonacoDiffProvider';
import { HooksManager } from './HooksManager';

let snapshotManager: SnapshotManager;
let webviewProvider: WebviewProvider;
let diffEditorManager: MonacoDiffProvider;
let hooksManager: HooksManager;
let fileWatcher: vscode.FileSystemWatcher | undefined;
let notifyWatcher: vscode.FileSystemWatcher | undefined;
let outputChannel: vscode.OutputChannel;

function log(msg: string): void {
  const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
  outputChannel.appendLine(`[${ts}] ${msg}`);
}

export function activate(context: vscode.ExtensionContext): void {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return;
  }

  const workspaceRoot = path.resolve(workspaceFolders[0].uri.fsPath);

  // ── Output channel ──
  outputChannel = vscode.window.createOutputChannel('CC Diff', { log: true });
  context.subscriptions.push(outputChannel);
  log(`Extension activated — workspace: ${workspaceRoot}`);

  // ── Hooks auto-update ──
  hooksManager = new HooksManager(context.extensionPath);
  hooksManager.setLogger(log);
  log('Checking hook scripts for updates...');
  hooksManager.autoUpdate(workspaceRoot);

  // ── SnapshotManager ──
  snapshotManager = new SnapshotManager();
  snapshotManager.setLogger(log);
  snapshotManager.setWorkspaceRoot(workspaceRoot);
  snapshotManager.loadFiles(workspaceRoot);

  // ── DiffEditorManager (replaces DiffPanelProvider) ──
  diffEditorManager = new MonacoDiffProvider(workspaceRoot, snapshotManager, outputChannel);
  context.subscriptions.push(diffEditorManager);
  // When all hunks for a file are processed, refresh sidebar
  diffEditorManager.onFileProcessed = () => {
    webviewProvider.refresh();
  };

  // ── WebviewProvider (sidebar) ──
  webviewProvider = new WebviewProvider(workspaceRoot, snapshotManager, outputChannel, diffEditorManager);

  // ── Sidebar webview ──
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('cc-diff.view', webviewProvider)
  );

  // ── File watcher: index.json ──
  const watchPattern = new vscode.RelativePattern(
    workspaceFolders[0],
    '.claude/cc-diff/index.json'
  );

  fileWatcher = vscode.workspace.createFileSystemWatcher(watchPattern, false, false, false);
  context.subscriptions.push(fileWatcher);

  fileWatcher.onDidCreate((uri) => {
    log(`FileWatcher: index.json created — ${uri.fsPath}`);
    snapshotManager.loadFiles(workspaceRoot);
    webviewProvider.refresh();
    if (snapshotManager.getAllFiles().length > 0) {
      vscode.commands.executeCommand('cc-diff.view.focus');
    }
  });

  fileWatcher.onDidChange((uri) => {
    const before = snapshotManager.getAllFiles().length;
    log(`FileWatcher: index.json changed — ${uri.fsPath}`);
    snapshotManager.loadFiles(workspaceRoot);
    webviewProvider.refresh();
    const after = snapshotManager.getAllFiles().length;
    if (after > before) {
      vscode.commands.executeCommand('cc-diff.view.focus');
      log(`FileWatcher: auto-focused cc-diff view (files: ${before} → ${after})`);
    }
  });

  fileWatcher.onDidDelete(() => {
    log('FileWatcher: index.json deleted');
    snapshotManager.loadFiles(workspaceRoot);
    webviewProvider.refresh();
  });

  // ── File watcher: notify signal ──
  const notifyPattern = new vscode.RelativePattern(
    workspaceFolders[0],
    '.claude/cc-diff/notify'
  );

  notifyWatcher = vscode.workspace.createFileSystemWatcher(notifyPattern, false, false, false);
  context.subscriptions.push(notifyWatcher);

  notifyWatcher.onDidCreate((uri) => {
    log(`NotifyWatcher: notify created — ${uri.fsPath}`);
    handleNotifySignal(workspaceRoot);
  });

  notifyWatcher.onDidChange((uri) => {
    log(`NotifyWatcher: notify changed — ${uri.fsPath}`);
    handleNotifySignal(workspaceRoot);
  });

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
    vscode.commands.registerCommand('cc-diff.noop', () => {})
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cc-diff.focus', () => {
      vscode.commands.executeCommand('cc-diff.view.focus');
    })
  );

  // File-level commands (called from sidebar or editor toolbar)
  context.subscriptions.push(
    vscode.commands.registerCommand('cc-diff.acceptAllFile', async (filePath: string) => {
      log(`Command: acceptAllFile — file="${filePath}"`);
      await diffEditorManager.acceptAll(filePath);
      webviewProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cc-diff.denyAllFile', async (filePath: string) => {
      log(`Command: denyAllFile — file="${filePath}"`);
      await diffEditorManager.denyAll(filePath);
      webviewProvider.refresh();
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

/**
 * Handle the notify signal from session-end.js Stop hook.
 * Reloads tracked files and auto-focuses the sidebar if there are changes.
 */
function handleNotifySignal(workspaceRoot: string): void {
  snapshotManager.loadFiles(workspaceRoot);
  webviewProvider.refresh();
  if (snapshotManager.getAllFiles().length > 0) {
    vscode.commands.executeCommand('cc-diff.view.focus');
    log('NotifyWatcher: auto-focused cc-diff view');
  }
}

export function deactivate(): void {
  log('Extension deactivated.');
  if (fileWatcher) {
    fileWatcher.dispose();
  }
  if (notifyWatcher) {
    notifyWatcher.dispose();
  }
}
