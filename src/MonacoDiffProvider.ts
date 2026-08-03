import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SnapshotManager } from './SnapshotManager';

/**
 * Manages a Monaco Diff Editor based WebviewPanel.
 * One panel shows one file at a time, reusing the open panel.
 */
export class MonacoDiffProvider {
  private _workspaceRoot: string;
  private _snapshotManager: SnapshotManager;
  private _outputChannel: vscode.OutputChannel;

  private _panel: vscode.WebviewPanel | null = null;
  private _currentFile: string = '';
  private _webviewReady: boolean = false;

  /** Base panel title (without the dirty marker). Appended with ' ●' when dirty. */
  private _titleBase: string = '';

  /** Cached data for when the webview sends 'ready' */
  private _pendingData: {
    file: string;
    original: string;
    modified: string;
  } | null = null;

  /** Called when all hunks in a file are processed */
  private _onFileProcessed: ((filePath: string) => void) | null = null;
  set onFileProcessed(cb: (filePath: string) => void) {
    this._onFileProcessed = cb;
  }

  constructor(
    workspaceRoot: string,
    snapshotManager: SnapshotManager,
    outputChannel: vscode.OutputChannel,
  ) {
    this._workspaceRoot = workspaceRoot;
    this._snapshotManager = snapshotManager;
    this._outputChannel = outputChannel;
  }

  /** Expose current file for editor/title commands */
  get currentFile(): string {
    return this._currentFile;
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  /** Open the Monaco diff view for the given file */
  openDiff(filePath: string): void {
    // If same file is already open, just reveal
    if (this._panel && this._currentFile === filePath) {
      this._panel.reveal();
      return;
    }

    // Get snapshot content — null means file creation (treat as empty)
    const snapshotContent = this._snapshotManager.getSnapshotContent(filePath) ?? '';

    const absPath = path.resolve(this._workspaceRoot, filePath);
    let currentContent = '';
    try {
      currentContent = fs.readFileSync(absPath, 'utf8');
    } catch {
      // File deleted — treat as empty
    }

    if (snapshotContent === currentContent) {
      vscode.window.showInformationMessage(
        vscode.l10n.t('CC Diff: No changes to display for "{0}".', filePath)
      );
      return;
    }

    this._pendingData = {
      file: filePath,
      original: snapshotContent,
      modified: currentContent,
    };

    // Create or reuse panel
    if (!this._panel) {
      this._panel = vscode.window.createWebviewPanel(
        'cc-diff.monacoDiff',
        'CC Diff',
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.file(path.join(__dirname, 'webview'))],
        }
      );

      this._panel.onDidDispose(() => {
        this._panel = null;
        this._currentFile = '';
        this._pendingData = null;
        this._webviewReady = false;
        this._titleBase = '';
      });

      this._panel.webview.onDidReceiveMessage((msg) => {
        this._handleMessage(msg).catch((err) => {
          this._outputChannel.appendLine(
            `[MonacoDiffProvider] unhandled error: ${err}`
          );
        });
      });

      // Load HTML
      this._panel.webview.html = this._readTemplate();
    }

    // Update title (keep base without dirty marker; a fresh file is clean)
    this._titleBase = `CC Diff: ${path.basename(filePath)}`;
    this._panel.title = this._titleBase;
    this._currentFile = filePath;

    // Send data only if webview is already ready (reused panel).
    // For new panels, wait for the 'ready' message from the webview.
    if (this._webviewReady) {
      this._sendPendingIfReady();
    }
    this._panel.reveal();
  }

  async keepAll(filePath: string): Promise<void> {
    this._snapshotManager.keepAll(filePath);
    if (this._currentFile === filePath) {
      this._panel?.webview.postMessage({ command: 'allProcessed' });
      this._panel?.dispose(); // onDidDispose cleans up state
      this._onFileProcessed?.(filePath);
    }
  }

  async undoAll(filePath: string): Promise<void> {
    const result = this._snapshotManager.undoAll(filePath, this._workspaceRoot);
    if (!result.success) {
      vscode.window.showErrorMessage(
        vscode.l10n.t('CC Diff: Failed to revert "{0}" — {1}', filePath, result.error || '')
      );
      return;
    }
    if (this._currentFile === filePath) {
      this._panel?.webview.postMessage({ command: 'allProcessed' });
      this._panel?.dispose(); // onDidDispose cleans up state
      this._onFileProcessed?.(filePath);
    }
  }

  hasActiveDiff(filePath: string): boolean {
    return this._currentFile === filePath && this._panel !== null;
  }

  dispose(): void {
    if (this._panel) {
      this._panel.dispose();
      this._panel = null;
    }
    this._currentFile = '';
    this._titleBase = '';
  }

  /** Navigate to previous/next hunk in the webview */
  navigateHunk(direction: 'prev' | 'next'): void {
    if (!this._panel) return;
    this._panel.webview.postMessage({ command: 'navigateHunk', direction });
  }

  /** Toggle between side-by-side and inline diff mode */
  toggleMode(): void {
    if (!this._panel) return;
    this._panel.webview.postMessage({ command: 'toggleMode' });
  }

  /** Ask webview for current cursor position, then open file at that line */
  openCurrentFile(): void {
    if (!this._panel || !this._currentFile) return;
    this._panel.webview.postMessage({ command: 'openCurrentFile' });
  }

  /**
   * Trigger save from the extension side (bound to the built-in Ctrl+S / File>Save).
   * Asks the webview for the modified model content, which replies with 'saveFile'.
   */
  save(): void {
    if (!this._panel || !this._currentFile) return;
    this._panel.webview.postMessage({ command: 'triggerSave' });
  }

  // ------------------------------------------------------------------
  // Message handling
  // ------------------------------------------------------------------

  private async _handleMessage(msg: any): Promise<void> {
    switch (msg.command) {
      case 'ready':
        this._webviewReady = true;
        this._sendPendingIfReady();
        break;

      case 'keepHunk': {
        if (!msg.change) return;

        const result = this._snapshotManager.keepHunk(
          this._currentFile,
          msg.change,
          this._workspaceRoot
        );
        if (!result.success) {
          vscode.window.showErrorMessage(
            vscode.l10n.t('CC Diff: Failed to keep hunk — {0}', result.error || '')
          );
          return;
        }
        this._refreshDiff();
        break;
      }

      case 'undoHunk': {
        if (!msg.change) return;

        const result = this._snapshotManager.undoHunk(
          this._currentFile,
          msg.change,
          this._workspaceRoot
        );
        if (!result.success) {
          vscode.window.showErrorMessage(
            vscode.l10n.t('CC Diff: Failed to undo hunk — {0}', result.error || '')
          );
          return;
        }
        this._refreshDiff();
        break;
      }

      case 'keepAll':
        await this.keepAll(this._currentFile);
        break;

      case 'undoAll':
        await this.undoAll(this._currentFile);
        break;

      case 'saveFile': {
        const absPath = path.resolve(this._workspaceRoot, this._currentFile);
        try {
          fs.mkdirSync(path.dirname(absPath), { recursive: true });
          fs.writeFileSync(absPath, msg.content, 'utf8');
          this._outputChannel.appendLine(
            `[MonacoDiffProvider] Saved "${this._currentFile}" from webview`
          );
          // Recompute hunks (snapshot vs updated file) and refresh the diff view
          this._refreshDiff();
        } catch (err: any) {
          vscode.window.showErrorMessage(
            vscode.l10n.t('CC Diff: Failed to save "{0}" — {1}', this._currentFile, err.message)
          );
        }
        break;
      }

      case 'dirtyChange':
        // Reflect unsaved-edit state in the panel title (like the editor dirty dot)
        this._setDirtyTitle(!!msg.dirty);
        break;

      case 'log':
        this._outputChannel.appendLine(
          `[MonacoDiffProvider webview] ${msg.text}`
        );
        break;

      case 'switchMode':
        // Log only, no action needed
        this._outputChannel.appendLine(
          `[MonacoDiffProvider] mode switched to ${msg.mode} for "${this._currentFile}"`
        );
        break;

      case 'openCurrentFile': {
        const absPath = path.resolve(this._workspaceRoot, msg.file);
        const line = typeof msg.line === 'number' ? msg.line : 1;
        try {
          const doc = await vscode.workspace.openTextDocument(absPath);
          const editor = await vscode.window.showTextDocument(doc, {
            viewColumn: vscode.ViewColumn.Active,
            preserveFocus: false,
          });
          const range = new vscode.Range(line - 1, 0, line - 1, 0);
          editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        } catch (err) {
          vscode.window.showErrorMessage(
            vscode.l10n.t('CC Diff: Failed to open "{0}" — {1}', msg.file || '', String(err))
          );
        }
        break;
      }
    }
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  /** Send render data if webview is ready and there is pending data */
  private _sendPendingIfReady(): void {
    if (!this._pendingData || !this._panel) return;

    const data = this._pendingData;
    this._pendingData = null;

    this._panel.webview.postMessage({
      command: 'renderDiff',
      file: data.file,
      original: data.original,
      modified: data.modified,
    });
  }

  /** Recompute diff and push to webview */
  private _refreshDiff(): void {
    if (!this._currentFile) return;

    // If the file is no longer tracked, its last hunk was just processed and
    // the entry cleaned up — nothing left to review. Treat as all processed
    // instead of re-reading an (empty) snapshot and rendering a bogus
    // whole-file diff.
    if (!this._snapshotManager.getFileEntry(this._currentFile)) {
      this._panel?.webview.postMessage({ command: 'allProcessed' });
      if (this._panel) {
        this._panel.dispose(); // onDidDispose cleans up state
      }
      this._onFileProcessed?.(this._currentFile);
      return;
    }

    // Treat missing snapshot as empty (file creation scenario)
    const snapshotContent = this._snapshotManager.getSnapshotContent(this._currentFile) ?? '';

    const absPath = path.resolve(this._workspaceRoot, this._currentFile);
    let currentContent = '';
    try {
      currentContent = fs.readFileSync(absPath, 'utf8');
    } catch {
      // File deleted
    }

    if (snapshotContent === currentContent) {
      // All processed
      this._panel?.webview.postMessage({ command: 'allProcessed' });
      if (this._panel) {
        this._panel.dispose(); // onDidDispose cleans up state
      }
      this._onFileProcessed?.(this._currentFile);
      return;
    }

    this._panel?.webview.postMessage({
      command: 'diffUpdated',
      file: this._currentFile,
      original: snapshotContent,
      modified: currentContent,
    });
  }

  /** Show/hide the unsaved-edits marker (' ●') in the panel title */
  private _setDirtyTitle(dirty: boolean): void {
    if (!this._panel || !this._titleBase) return;
    this._panel.title = dirty ? `${this._titleBase} ●` : this._titleBase;
  }

  private buildI18nScript(): string {
    const strings: Record<string, string> = {
      '@@locale': vscode.env.language,
      loading: vscode.l10n.t('Loading diff editor...'),
      keepAll: vscode.l10n.t('Keep All'),
      undoAll: vscode.l10n.t('Undo All'),
      keep: vscode.l10n.t('Keep'),
      undo: vscode.l10n.t('Undo'),
      hunksRemaining: vscode.l10n.t('hunk(s) remaining'),
      allProcessed: vscode.l10n.t('All changes processed.'),
      // Detect the display language directly (vscode.env.language) so the
      // tooltip is reliable even when the l10n bundle isn't loaded yet.
      prevHunk: vscode.l10n.t(/^zh/i.test(vscode.env.language) ? '上一个修改' : 'Previous Hunk'),
      nextHunk: vscode.l10n.t(/^zh/i.test(vscode.env.language) ? '下一个修改' : 'Next Hunk'),
    };
    return `<script>window.__i18n=${JSON.stringify(strings)};</script>`;
  }

  /** Read the monaco-diff.html template and inject webview URIs */
  private _readTemplate(): string {
    const templatePath = this._resolveTemplatePath();
    let template: string;
    if (templatePath && fs.existsSync(templatePath)) {
      template = fs.readFileSync(templatePath, 'utf8');
    } else {
      return `<!DOCTYPE html><html><body><p>${vscode.l10n.t('Error: Monaco diff template not found.')}</p></body></html>`;
    }

    // Inject webview URIs for the Monaco loader and base
    template = template.replace('</head>', this.buildI18nScript() + '\n</head>');
    const loaderUri = this._panel!.webview.asWebviewUri(
      vscode.Uri.file(path.join(__dirname, 'webview', 'vs', 'loader.js'))
    );
    const baseUri = this._panel!.webview.asWebviewUri(
      vscode.Uri.file(path.join(__dirname, 'webview'))
    );
    return template
      .replace('__MONACO_LOADER_JS__', loaderUri.toString())
      .replaceAll('__MONACO_BASE_URI__', baseUri.toString() + '/');
  }

  private _resolveTemplatePath(): string {
    const candidates = [
      path.join(__dirname, 'webview', 'monaco-diff.html'),
      path.join(__dirname, '..', 'src', 'webview', 'monaco-diff.html'),
      path.join(__dirname, '..', 'webview', 'monaco-diff.html'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return candidates[0];
  }
}
