import * as fs from 'fs';
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
let branchCleanupWatcher: vscode.FileSystemWatcher | undefined;
// Suppress repeated branch-cleanup prompts after user dismisses.
// Cleared when the branch changes again (so the prompt re-appears).
let suppressedBranchCleanup: string | null = null;
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

  // ── File watcher: branch-cleanup signal ──
  const branchCleanupPattern = new vscode.RelativePattern(
    workspaceFolders[0],
    '.claude/cc-diff/branch-cleanup'
  );

  branchCleanupWatcher = vscode.workspace.createFileSystemWatcher(branchCleanupPattern, false, false, false);
  context.subscriptions.push(branchCleanupWatcher);

  branchCleanupWatcher.onDidCreate((uri) => {
    log(`BranchCleanupWatcher: signal created — ${uri.fsPath}`);
    handleBranchCleanupSignal(workspaceRoot);
  });

  branchCleanupWatcher.onDidChange((uri) => {
    log(`BranchCleanupWatcher: signal changed — ${uri.fsPath}`);
    handleBranchCleanupSignal(workspaceRoot);
  });

  // ── Status bar ──
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  statusBarItem.command = 'cc-diff.focus';
  statusBarItem.text = '$(diff) CC Diff';
  statusBarItem.tooltip = vscode.l10n.t('Show CC Diff panel');
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
    vscode.commands.registerCommand('cc-diff.keepAllFile', async (filePath: string) => {
      log(`Command: keepAllFile — file="${filePath}"`);
      await diffEditorManager.keepAll(filePath);
      webviewProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cc-diff.undoAllFile', async (filePath: string) => {
      log(`Command: undoAllFile — file="${filePath}"`);
      await diffEditorManager.undoAll(filePath);
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
          vscode.l10n.t('CC Diff: Hook scripts installed successfully! Check .claude/settings.json')
        );
      } catch (err: any) {
        log(`Command: setupHooks FAILED — ${err.message}`);
        vscode.window.showErrorMessage(
          vscode.l10n.t('CC Diff: Hook installation failed — {0}', err.message)
        );
      }
    })
  );

  // ── Editor/title commands (Monaco diff panel) ──
  context.subscriptions.push(
    vscode.commands.registerCommand('cc-diff.keepAllFileEditor', async () => {
      const file = diffEditorManager.currentFile;
      if (!file) return;
      log(`Command: keepAllFileEditor — file="${file}"`);
      await diffEditorManager.keepAll(file);
      webviewProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cc-diff.undoAllFileEditor', async () => {
      const file = diffEditorManager.currentFile;
      if (!file) return;
      log(`Command: undoAllFileEditor — file="${file}"`);
      await diffEditorManager.undoAll(file);
      webviewProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cc-diff.prevHunk', () => {
      log('Command: prevHunk');
      diffEditorManager.navigateHunk('prev');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cc-diff.nextHunk', () => {
      log('Command: nextHunk');
      diffEditorManager.navigateHunk('next');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cc-diff.toggleDiffMode', () => {
      log('Command: toggleDiffMode');
      diffEditorManager.toggleMode();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cc-diff.openCurrentFile', () => {
      log('Command: openCurrentFile');
      diffEditorManager.openCurrentFile();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cc-diff.saveDiff', () => {
      log('Command: saveDiff');
      diffEditorManager.save();
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

/**
 * Handle the branch-cleanup signal from pre-tool-use.js.
 * Shows a non-modal prompt to clean up snapshots from a different branch.
 */
async function handleBranchCleanupSignal(workspaceRoot: string): Promise<void> {
  const ccDiffDir = path.join(workspaceRoot, '.claude', 'cc-diff');
  const signalPath = path.join(ccDiffDir, 'branch-cleanup');

  // Reload to get current state
  snapshotManager.loadFiles(workspaceRoot);

  const currentBranch = snapshotManager.getCurrentGitBranch();
  if (!currentBranch) {
    // Not a git repo — clean up signal and bail
    try { fs.unlinkSync(signalPath); } catch {}
    return;
  }

  // Suppress if user already dismissed for this exact branch
  if (suppressedBranchCleanup === currentBranch) {
    log(`BranchCleanupWatcher: suppressed for branch "${currentBranch}" — skipping`);
    try { fs.unlinkSync(signalPath); } catch {}
    return;
  }

  // Branch changed since last suppression → re-enable prompt
  if (suppressedBranchCleanup !== null && suppressedBranchCleanup !== currentBranch) {
    log(`BranchCleanupWatcher: branch changed from "${suppressedBranchCleanup}" to "${currentBranch}" — re-enabling`);
    suppressedBranchCleanup = null;
  }

  const mismatched = snapshotManager.getMismatchedFiles(currentBranch);
  if (mismatched.length === 0) {
    // No mismatch anymore (maybe already cleaned) — remove signal
    try { fs.unlinkSync(signalPath); } catch {}
    return;
  }

  const branches = [...new Set(mismatched.map(f => f.branch).filter(Boolean))];
  const branchList = branches.join(', ');
  const fileList = mismatched.map(f => f.file).join('\n');

  const answer = await vscode.window.showWarningMessage(
    vscode.l10n.t(
      'Detected Git branch switch (current: `{0}`, snapshot belongs to: `{1}`).\n\n{2} file(s) from other branch — clean up?\n\n{3}',
      currentBranch, branchList, mismatched.length, fileList
    ),
    vscode.l10n.t('Clean Up'),
    vscode.l10n.t('Cancel')
  );

  if (answer === vscode.l10n.t('Clean Up')) {
    for (const f of mismatched) {
      snapshotManager.removeTrackedFile(f.file);
    }
    log(`BranchCleanupWatcher: cleaned up ${mismatched.length} file(s) from branch(es) ${branchList}`);
    suppressedBranchCleanup = null;
    webviewProvider.refresh();
  } else {
    // User dismissed — suppress for this branch until it changes again
    suppressedBranchCleanup = currentBranch;
    log(`BranchCleanupWatcher: user dismissed — suppressing for branch "${currentBranch}"`);
  }

  // Always remove the signal file so future mismatches can re-trigger
  try { fs.unlinkSync(signalPath); } catch {}
}

export function deactivate(): void {
  log('Extension deactivated.');
  if (fileWatcher) {
    fileWatcher.dispose();
  }
  if (notifyWatcher) {
    notifyWatcher.dispose();
  }
  if (branchCleanupWatcher) {
    branchCleanupWatcher.dispose();
  }
}
