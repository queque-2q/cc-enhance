import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SnapshotManager, type HunkData } from './SnapshotManager';

/**
 * Manages a custom diff editor as a WebviewPanel.
 * One panel per file — reuses existing panel if already open for the same file.
 */
export class DiffPanelProvider {
  private _workspaceRoot: string;
  private _snapshotManager: SnapshotManager;
  private _outputChannel: vscode.OutputChannel;
  /** Currently open panel + the file it's showing. */
  private _panel: vscode.WebviewPanel | null = null;
  private _currentFile: string = '';

  constructor(
    workspaceRoot: string,
    snapshotManager: SnapshotManager,
    outputChannel: vscode.OutputChannel
  ) {
    this._workspaceRoot = workspaceRoot;
    this._snapshotManager = snapshotManager;
    this._outputChannel = outputChannel;
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  /**
   * Open (or reveal) the custom diff panel for a file.
   * Computes diff on-the-fly: git diff --no-index snapshot vs current file.
   */
  openDiff(filePath: string): void {
    // If a panel is already open for this file, reveal it
    if (this._panel && this._currentFile === filePath) {
      this._panel.reveal();
      return;
    }

    // Compute diff
    const hunks = this._snapshotManager.computeDiff(filePath, this._workspaceRoot);
    if (hunks.length === 0) {
      vscode.window.showInformationMessage(`CC Diff: No changes to display for "${filePath}".`);
      return;
    }

    // Read current file content (for initial render reference)
    const absPath = path.resolve(this._workspaceRoot, filePath);
    let currentContent = '';
    try {
      currentContent = fs.readFileSync(absPath, 'utf8');
    } catch {}

    // Create or reuse panel
    if (!this._panel) {
      this._panel = vscode.window.createWebviewPanel(
        'cc-diff.diffPanel',
        'CC Diff',
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [],
        }
      );

      this._panel.onDidDispose(() => {
        this._panel = null;
        this._currentFile = '';
        // Notify sidebar to refresh (remaining hunks may need processing)
        this._onPanelDisposed?.();
      });

      this._panel.webview.onDidReceiveMessage(this._handleMessage.bind(this));
    }

    // Update title
    this._panel.title = `CC Diff: ${path.basename(filePath)}`;
    this._currentFile = filePath;

    // Load template and render
    const html = this._buildHtml(filePath, hunks, currentContent);
    this._panel.webview.html = html;
    this._panel.reveal();
  }

  /** Callback invoked when the diff panel is closed. */
  private _onPanelDisposed: (() => void) | null = null;
  set onPanelDisposed(cb: () => void) {
    this._onPanelDisposed = cb;
  }

  // ------------------------------------------------------------------
  // Message handling
  // ------------------------------------------------------------------

  private async _handleMessage(msg: any): Promise<void> {
    const { command, file, hunkId, lineIndex, lineType, newText } = msg;

    switch (command) {
      case 'ready':
        // Webview is ready — nothing to do (already rendered)
        break;

      case 'editLine':
        this._handleEditLine(file, hunkId, lineIndex, lineType, newText);
        break;

      case 'acceptHunk': {
        const hunk = this._findHunk(file, hunkId);
        if (!hunk) return;
        const result = this._snapshotManager.acceptHunk(file, hunk, this._workspaceRoot);
        if (!result.success) {
          vscode.window.showErrorMessage(`CC Diff: Failed to accept hunk — ${result.error}`);
          return;
        }
        this._notifyHunkProcessed(hunkId);
        this._checkAllProcessed(file);
        break;
      }

      case 'denyHunk': {
        const hunk = this._findHunk(file, hunkId);
        if (!hunk) return;
        const result = this._snapshotManager.denyHunk(file, hunk, this._workspaceRoot);
        if (!result.success) {
          vscode.window.showErrorMessage(`CC Diff: Failed to deny hunk — ${result.error}`);
          return;
        }
        this._notifyHunkProcessed(hunkId);
        this._checkAllProcessed(file);
        break;
      }

      case 'acceptAll':
        this._snapshotManager.acceptAll(file);
        this._panel?.webview.postMessage({ command: 'allProcessed' });
        if (this._panel) {
          this._panel.dispose();  // onDidDispose calls _onPanelDisposed
        }
        break;

      case 'denyAll': {
        const result = this._snapshotManager.denyAll(file, this._workspaceRoot);
        if (!result.success) {
          vscode.window.showErrorMessage(`CC Diff: Failed to deny all — ${result.error}`);
          return;
        }
        this._panel?.webview.postMessage({ command: 'allProcessed' });
        if (this._panel) {
          this._panel.dispose();  // onDidDispose calls _onPanelDisposed
        }
        break;
      }
    }
  }

  /**
   * Write a line edit from the diff panel to the workspace file.
   *
   * Strategy: The webview sends the full new text of an edited line.
   * We find the corresponding line in the current file by matching
   * against the original hunk context and write the replacement.
   *
   * For v1: the webview sends newText which is the full line content.
   * We read the current file, find the line at the given position
   * relative to the hunk, and replace it.
   */
  private _handleEditLine(filePath: string, hunkId: number, lineIndex: number, lineType: string, newText: string): void {
    if (lineType === 'removed') return;

    const absPath = path.resolve(this._workspaceRoot, filePath);
    if (!fs.existsSync(absPath)) return;

    // Recompute hunks to get the original hunk data
    const hunks = this._snapshotManager.computeDiff(filePath, this._workspaceRoot);
    const hunk = hunks.find(h => h.id === hunkId);
    if (!hunk) return;

    // Parse hunk lines to find the corresponding original line
    const hunkLines = hunk.patch.split('\n');
    // Skip header line
    let hunkLineIdx = 0; // index within body lines
    let targetOriginalLine: string | null = null;

    for (let i = 1; i < hunkLines.length; i++) {
      const line = hunkLines[i];
      if (line === '' && i === hunkLines.length - 1) continue; // trailing empty

      if (hunkLineIdx === lineIndex) {
        targetOriginalLine = line;
        break;
      }
      hunkLineIdx++;
    }

    if (!targetOriginalLine) return;

    // Extract original text (without prefix char)
    const originalText = targetOriginalLine.startsWith('+') || targetOriginalLine.startsWith(' ')
      ? targetOriginalLine.substring(1)
      : targetOriginalLine;

    // Read current file, find and replace the line
    try {
      let content = fs.readFileSync(absPath, 'utf8');
      // Simple string replacement of first occurrence
      // (matches the line within the hunk context)
      if (content.includes(originalText)) {
        content = content.replace(originalText, newText);
        fs.writeFileSync(absPath, content, 'utf8');
      }
    } catch {
      // Silently fail — the user can always re-edit
    }
  }

  /**
   * Re-read current hunks from disk for a file.
   * Used to find a specific hunk by ID for accept/deny operations.
   */
  private _findHunk(filePath: string, hunkId: number): HunkData | null {
    const hunks = this._snapshotManager.computeDiff(filePath, this._workspaceRoot);
    return hunks.find(h => h.id === hunkId) || null;
  }

  /**
   * Notify webview that a hunk has been processed (remove it from display).
   */
  private _notifyHunkProcessed(hunkId: number): void {
    this._panel?.webview.postMessage({ command: 'hunkProcessed', hunkId });
  }

  /**
   * After each hunk operation, check if all hunks are processed.
   * If so, close the panel and notify.
   */
  private _checkAllProcessed(filePath: string): void {
    const remaining = this._snapshotManager.computeDiff(filePath, this._workspaceRoot);
    if (remaining.length === 0) {
      // All processed — close panel
      setTimeout(() => {
        this._panel?.webview.postMessage({ command: 'allProcessed' });
        if (this._panel) {
          this._panel.dispose();  // onDidDispose calls _onPanelDisposed
        }
      }, 200);
    }
  }

  // ------------------------------------------------------------------
  // HTML generation
  // ------------------------------------------------------------------

  private _buildHtml(filePath: string, hunks: HunkData[], currentContent: string): string {
    const templatePath = this._resolveTemplatePath();
    if (!templatePath || !fs.existsSync(templatePath)) {
      return `<!DOCTYPE html><html><body><p>Error: diff template not found.</p></body></html>`;
    }

    let html = fs.readFileSync(templatePath, 'utf8');

    // Inject initial state as a renderDiff message that fires on load
    const initState = JSON.stringify({
      command: 'renderDiff',
      file: filePath,
      hunks: hunks,
      currentContent: currentContent,
    });
    // Escape </script> sequences that would break the injected script block
    const safeInitState = initState.replace(/<\//g, '<\\/');

    // Replace the placeholder or inject after script start
    // The template's script already sends 'ready' — we respond with renderDiff
    // We replace the ready handler behavior with immediate render
    html = html.replace(
      "vscode.postMessage({ command: 'ready' });",
      `vscode.postMessage({ command: 'ready' });
      // Auto-render initial state
      window.addEventListener('message', function initHandler(e) {
        if (e.data.command === 'renderDiff') {
          window.removeEventListener('message', initHandler);
        }
      });
      // Directly inject initial state
      (function() {
        var initMsg = ${safeInitState};
        state.file = initMsg.file;
        state.hunks = initMsg.hunks;
        state.currentContent = initMsg.currentContent;
        render();
      })();`
    );

    return html;
  }

  private _resolveTemplatePath(): string {
    const candidates = [
      path.join(__dirname, 'webview', 'diff.html'),
      path.join(__dirname, '..', 'src', 'webview', 'diff.html'),
      path.join(__dirname, '..', 'webview', 'diff.html'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return candidates[0];
  }
}
