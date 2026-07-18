import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SnapshotManager, type TrackedFile } from './SnapshotManager';
import { DiffPanelProvider } from './DiffPanelProvider';

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
  private _diffPanelProvider: DiffPanelProvider;

  constructor(
    workspaceRoot: string,
    snapshotManager: SnapshotManager,
    outputChannel: vscode.OutputChannel,
    diffPanelProvider: DiffPanelProvider
  ) {
    this._workspaceRoot = workspaceRoot;
    this._snapshotManager = snapshotManager;
    this._outputChannel = outputChannel;
    this._diffPanelProvider = diffPanelProvider;
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
        this.refresh();
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

  // ------------------------------------------------------------------
  // Message handling
  // ------------------------------------------------------------------

  private async handleMessage(msg: any): Promise<void> {
    const { command, file } = msg;

    switch (command) {
      case 'openDiff':
        this._diffPanelProvider.openDiff(file);
        break;

      case 'acceptFile': {
        this._snapshotManager.acceptAll(file);
        this.refresh();
        break;
      }

      case 'denyFile': {
        const result = this._snapshotManager.denyAll(file, this._workspaceRoot);
        if (!result.success) {
          vscode.window.showErrorMessage(`CC Diff: Failed to revert "${file}" — ${result.error}`);
        }
        this.refresh();
        break;
      }

      case 'acceptAll': {
        const answer = await vscode.window.showInformationMessage(
          'Accept all changes in all files?',
          { modal: true },
          'Accept All'
        );
        if (answer === 'Accept All') {
          for (const f of this._snapshotManager.getAllFiles()) {
            this._snapshotManager.acceptAll(f);
          }
          this.refresh();
        }
        break;
      }

      case 'denyAll': {
        const answer = await vscode.window.showInformationMessage(
          'Deny (revert) all changes in all files? This will undo all modifications.',
          { modal: true },
          'Deny All'
        );
        if (answer === 'Deny All') {
          const files = [...this._snapshotManager.getAllFiles()]; // copy before iterating
          const errors: string[] = [];
          for (const f of files) {
            const result = this._snapshotManager.denyAll(f, this._workspaceRoot);
            if (!result.success) {
              errors.push(`${f}: ${result.error}`);
            }
          }
          if (errors.length > 0) {
            vscode.window.showErrorMessage(
              `CC Diff: ${errors.length}/${files.length} file(s) failed to revert:\n${errors.join('\n')}`
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

  private buildHtml(initialFiles?: FileSummary[]): string {
    const initialJson = JSON.stringify(initialFiles || []);
    try {
      const templatePath = this.resolveTemplatePath();
      let html = fs.readFileSync(templatePath, 'utf8');
      return html.replace('__INITIAL_FILES__', initialJson);
    } catch (error) {
      this._outputChannel.appendLine(`[ERROR] Failed to load webview template: ${error}`);
      return `<!DOCTYPE html><html><body><pre>Failed to load webview template.</pre></body></html>`;
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
