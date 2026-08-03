import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SnapshotManager, type TrackedFile, buildBranchNotice } from './SnapshotManager';
import { MonacoDiffProvider } from './MonacoDiffProvider';

// ======================================================================
// Types for webview communication
// ======================================================================

interface FileSummary {
  file: string;
  sessionId: string;
  timestamp: number;
  status: string;
}

// ======================================================================
// WebviewProvider
// ======================================================================

export class WebviewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _workspaceRoot: string;
  private _snapshotManager: SnapshotManager;
  private _outputChannel: vscode.OutputChannel;
  private _diffEditorManager: MonacoDiffProvider;

  constructor(
    workspaceRoot: string,
    snapshotManager: SnapshotManager,
    outputChannel: vscode.OutputChannel,
    diffEditorManager: MonacoDiffProvider
  ) {
    this._workspaceRoot = workspaceRoot;
    this._snapshotManager = snapshotManager;
    this._outputChannel = outputChannel;
    this._diffEditorManager = diffEditorManager;
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [],
    };

    const initialSummaries = this.buildFileList();
    webviewView.webview.html = this.buildHtml(initialSummaries);

    webviewView.webview.onDidReceiveMessage(this.handleMessage.bind(this));

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.checkBranchMismatch();
      }
    });
  }

  // ------------------------------------------------------------------
  // Data
  // ------------------------------------------------------------------

  private buildFileList(): FileSummary[] {
    const allFiles = this._snapshotManager.getAllFiles();
    const summaries: FileSummary[] = [];

    for (const file of allFiles) {
      const entry = this._snapshotManager.getFileEntry(file);
      if (!entry) continue;

      // Compatibility: if both snapshot (or empty snapshot) and workspace
      // file are missing, remove the stale entry from the list.
      const snapshotContent = this._snapshotManager.getSnapshotContent(file);
      const snapshotExists = snapshotContent !== null && snapshotContent !== '';
      const workspacePath = path.resolve(this._workspaceRoot, file);
      const workspaceExists = fs.existsSync(workspacePath);

      if (!snapshotExists && !workspaceExists) {
        this._snapshotManager.removeTrackedFile(file);
        continue;
      }

      summaries.push({
        file: entry.file,
        sessionId: entry.sessionId,
        timestamp: entry.timestamp,
        status: entry.status,
      });
    }

    return summaries;
  }

  refresh(): void {
    if (!this._view) return;
    const files = this.buildFileList();
    this._view.webview.postMessage({ command: 'updateState', files });
  }

  /**
   * Check if any tracked files were recorded on a different git branch.
   * If so, prompt the user to clean them up.
   */
  private async checkBranchMismatch(): Promise<void> {
    const currentBranch = this._snapshotManager.getCurrentGitBranch();
    if (!currentBranch) {
      // Not a git repo — nothing to check
      this.refresh();
      return;
    }

    const mismatched = this._snapshotManager.getMismatchedFiles(currentBranch);
    if (mismatched.length === 0) {
      this.refresh();
      return;
    }

    const cleanUpLabel = vscode.l10n.t('Clean Up');
    const answer = await vscode.window.showWarningMessage(
      buildBranchNotice(currentBranch, mismatched),
      { modal: true },
      cleanUpLabel
    );

    if (answer === cleanUpLabel) {
      for (const f of mismatched) {
        this._snapshotManager.removeTrackedFile(f.file);
      }
      this._outputChannel.appendLine(
        `[WebviewProvider] Branch mismatch cleanup: removed ${mismatched.length} file(s) from branch(es) ${[...new Set(mismatched.map(f => f.branch).filter(Boolean))].join(', ')}`
      );
    }

    this.refresh();
  }

  // ------------------------------------------------------------------
  // Message handling
  // ------------------------------------------------------------------

  private async handleMessage(msg: any): Promise<void> {
    const { command, file } = msg;

    switch (command) {
      case 'openDiff':
        this._diffEditorManager.openDiff(file);
        break;

      case 'keepFile': {
        this._snapshotManager.keepAll(file);
        if (this._diffEditorManager.hasActiveDiff(file)) {
          this._diffEditorManager.keepAll(file);
        }
        this.refresh();
        break;
      }

      case 'undoFile': {
        if (this._diffEditorManager.hasActiveDiff(file)) {
          this._diffEditorManager.undoAll(file);
        } else {
          const result = this._snapshotManager.undoAll(file, this._workspaceRoot);
          if (!result.success) {
            vscode.window.showErrorMessage(
              vscode.l10n.t('CC Diff: Failed to revert "{0}" — {1}', file, result.error || '')
            );
          }
        }
        this.refresh();
        break;
      }

      case 'keepAll': {
        const keepAllLabel = vscode.l10n.t('Keep All');
        const answer = await vscode.window.showInformationMessage(
          vscode.l10n.t('Keep all changes in all files?'),
          { modal: true },
          keepAllLabel
        );
        if (answer === keepAllLabel) {
          for (const f of this._snapshotManager.getAllFiles()) {
            this._snapshotManager.keepAll(f);
          }
          this.refresh();
        }
        break;
      }

      case 'undoAll': {
        const undoAllLabel = vscode.l10n.t('Undo All');
        const answer = await vscode.window.showInformationMessage(
          vscode.l10n.t('Undo (revert) all changes in all files? This will undo all modifications.'),
          { modal: true },
          undoAllLabel
        );
        if (answer === undoAllLabel) {
          const files = [...this._snapshotManager.getAllFiles()]; // copy before iterating
          const errors: string[] = [];
          for (const f of files) {
            const result = this._snapshotManager.undoAll(f, this._workspaceRoot);
            if (!result.success) {
              errors.push(`${f}: ${result.error}`);
            }
          }
          if (errors.length > 0) {
            vscode.window.showErrorMessage(
              vscode.l10n.t('CC Diff: {0}/{1} file(s) failed to revert:\n{2}', errors.length, files.length, errors.join('\n'))
            );
          }
          this.refresh();
        }
        break;
      }

      case 'refresh':
        this._snapshotManager.loadFiles(this._workspaceRoot);
        this.refresh();
        break;
    }
  }

  // ------------------------------------------------------------------
  // HTML generation
  // ------------------------------------------------------------------

  private buildI18nScript(): string {
    const strings: Record<string, string> = {
      '@@locale': vscode.env.language,
      noChanges: vscode.l10n.t('No changes to review'),
      noChangesDesc: vscode.l10n.t('File diffs from Claude Code sessions appear here after each conversation.'),
      keep: vscode.l10n.t('Keep'),
      undo: vscode.l10n.t('Undo'),
      keepAll: vscode.l10n.t('Keep All'),
      undoAll: vscode.l10n.t('Undo All'),
      reviewed: vscode.l10n.t('reviewed'),
      session: vscode.l10n.t('session'),
    };
    return `<script>window.__i18n=${JSON.stringify(strings)};</script>`;
  }

  private buildHtml(initialFiles?: FileSummary[]): string {
    const initialJson = JSON.stringify(initialFiles || []);
    try {
      const templatePath = this.resolveTemplatePath();
      let html = fs.readFileSync(templatePath, 'utf8');
      html = html.replace('</head>', this.buildI18nScript() + '\n</head>');
      return html.replace('__INITIAL_FILES__', initialJson);
    } catch (error) {
      this._outputChannel.appendLine(`[ERROR] Failed to load webview template: ${error}`);
      return `<!DOCTYPE html><html><body><pre>${vscode.l10n.t('Failed to load webview template.')}</pre></body></html>`;
    }
  }

  private resolveTemplatePath(): string {
    const candidates = [
      path.join(__dirname, 'webview', 'index.html'),
      path.join(__dirname, '..', 'src', 'webview', 'index.html'),
      path.join(__dirname, '..', 'webview', 'index.html'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return candidates[0];
  }
}
