import * as vscode from 'vscode';
import { DiffManager } from './DiffManager';
import { WebviewProvider } from './WebviewProvider';
import { HooksManager } from './HooksManager';

let diffManager: DiffManager;
let webviewProvider: WebviewProvider;
let hooksManager: HooksManager;
let fileWatcher: vscode.FileSystemWatcher | undefined;
let changeListener: vscode.Disposable | undefined;

export function activate(context: vscode.ExtensionContext): void {
  // Determine workspace root
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return; // No workspace open — nothing to do
  }
  const workspaceRoot = workspaceFolders[0].uri.fsPath;

  // Auto-update hooks if already installed (best-effort, don't block)
  hooksManager = new HooksManager(context.extensionPath);
  hooksManager.autoUpdate(workspaceRoot);

  // Initialize DiffManager and load existing sessions
  diffManager = new DiffManager();
  diffManager.loadSessions(workspaceRoot);
  diffManager.cleanOldSessions(workspaceRoot);

  // Create WebviewProvider
  webviewProvider = new WebviewProvider(workspaceRoot, diffManager);

  // Register the sidebar webview
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('cc-diff.view', webviewProvider)
  );

  // Watch for new session.json signal files
  // VSCode's FileSystemWatcher uses workspace-relative patterns
  const watchPattern = new vscode.RelativePattern(
    workspaceFolders[0],
    '.claude/cc-diff/patches/*/session.json'
  );

  fileWatcher = vscode.workspace.createFileSystemWatcher(watchPattern, false, false, false);
  context.subscriptions.push(fileWatcher);

  fileWatcher.onDidCreate(() => {
    diffManager.loadSessions(workspaceRoot);
    webviewProvider.refresh();
  });

  fileWatcher.onDidChange(() => {
    diffManager.loadSessions(workspaceRoot);
    webviewProvider.refresh();
  });

  fileWatcher.onDidDelete(() => {
    diffManager.loadSessions(workspaceRoot);
    webviewProvider.refresh();
  });

  // Listen for manual file edits (100ms debounce via the provider)
  changeListener = vscode.workspace.onDidChangeTextDocument((e) => {
    if (e.document.uri.scheme !== 'file') return;
    const relativePath = vscode.workspace.asRelativePath(e.document.uri);
    webviewProvider.notifyFileChanged(relativePath);
  });
  context.subscriptions.push(changeListener);

  // Status bar item
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  statusBarItem.command = 'cc-diff.focus';
  statusBarItem.text = '$(diff) CC Diff';
  statusBarItem.tooltip = 'Show CC Diff panel';
  context.subscriptions.push(statusBarItem);
  statusBarItem.show();

  // Register the focus command
  context.subscriptions.push(
    vscode.commands.registerCommand('cc-diff.focus', () => {
      vscode.commands.executeCommand('cc-diff.view.focus');
    })
  );

  // Register the setupHooks command
  context.subscriptions.push(
    vscode.commands.registerCommand('cc-diff.setupHooks', async () => {
      try {
        await hooksManager.setupHooks(workspaceRoot);
        vscode.window.showInformationMessage(
          'CC Diff: Hook 脚本安装成功！请查看 .claude/settings.json'
        );
      } catch (err: any) {
        vscode.window.showErrorMessage(`CC Diff: Hook 安装失败 — ${err.message}`);
      }
    })
  );
}

export function deactivate(): void {
  if (fileWatcher) {
    fileWatcher.dispose();
  }
  if (changeListener) {
    changeListener.dispose();
  }
}
