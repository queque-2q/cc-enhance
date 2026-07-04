import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { DiffManager, type PatchEntry } from './DiffManager';

function resolveWebviewTemplatePath(): string {
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

// ======================================================================
// Types for webview communication
// ======================================================================

interface FileSummary {
  file: string;
  patchId: string;       // Primary patch ID for accept/deny operations
  sessionId: string;     // For display only
  hunks: number;
  status: string;
  acceptedCount: number;
  deniedCount: number;
  acceptedHunks: number[];
  deniedHunks: number[];
}

// ======================================================================
// WebviewProvider
// ======================================================================

export class WebviewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _workspaceRoot: string;
  private _diffManager: DiffManager;
  private _outputChannel: vscode.OutputChannel;
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Files that have already had a conflict notification shown recently (dedup set). */
  private _conflictNotified: Set<string> = new Set();

  constructor(workspaceRoot: string, diffManager: DiffManager, outputChannel: vscode.OutputChannel) {
    this._workspaceRoot = workspaceRoot;
    this._diffManager = diffManager;
    this._outputChannel = outputChannel;
    // Debug: confirm WebviewProvider was constructed
    try {
      fs.writeFileSync(
        path.join(workspaceRoot, '.claude', 'cc-diff', '.debug-provider-constructed.txt'),
        `WebviewProvider constructed at ${new Date().toISOString()}\nworkspaceRoot=${workspaceRoot}`,
        'utf8'
      );
    } catch {}
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    // Debug: write flag file to confirm resolveWebviewView is called
    const debugFlag = path.join(this._workspaceRoot, '.claude', 'cc-diff', '.debug-resolve-called.txt');
    fs.writeFileSync(debugFlag, `resolveWebviewView called at ${new Date().toISOString()}\nworkspaceRoot=${this._workspaceRoot}`, 'utf8');

    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [],
    };

    // Build HTML with initial state embedded so patches show immediately
    const initialSummaries = this.buildFileList();
    webviewView.webview.html = this.buildHtml(initialSummaries);

    // Debug: write generated HTML to file
    const debugPath2 = path.join(this._workspaceRoot, '.claude', 'cc-diff', '.debug-webview.html');
    fs.writeFileSync(debugPath2, webviewView.webview.html, 'utf8');

    webviewView.webview.onDidReceiveMessage(this.handleMessage.bind(this));

    // Refresh when the webview becomes visible again (tab switch / reopen)
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.refresh();
      }
    });
  }

  /**
   * Build a flat file list from all patches.
   * Each file appears once, showing the primary (newest) patch ID
   * for accept/deny operations. The DiffManager handles layered
   * reverse-apply internally.
   */
  private buildFileList(): FileSummary[] {
    const allFiles = this._diffManager.getAllFiles();
    const summaries: FileSummary[] = [];

    for (const file of allFiles) {
      const patches = this._diffManager.getPatchesForFile(file);
      if (patches.length === 0) continue;

      // Use the newest patch as the primary for accept/deny
      const primary = patches[patches.length - 1];

      // Skip fully processed patches
      const activePatches = patches.filter(p => p.status !== 'accepted' && p.status !== 'denied');
      if (activePatches.length === 0) continue;

      // Aggregate hunk counts across all active patches
      let totalHunks = 0;
      let acceptedCount = 0;
      let deniedCount = 0;
      const acceptedHunks: number[] = [];
      const deniedHunks: number[] = [];
      let overallStatus: string = 'pending';

      for (const p of activePatches) {
        totalHunks += p.hunks.length;
        acceptedCount += p.acceptedHunks.size;
        deniedCount += p.deniedHunks.size;
        for (const h of p.acceptedHunks) acceptedHunks.push(h);
        for (const h of p.deniedHunks) deniedHunks.push(h);
      }

      if (acceptedCount + deniedCount === 0) {
        overallStatus = 'pending';
      } else if (acceptedCount + deniedCount === totalHunks) {
        overallStatus = deniedCount > 0 ? 'denied' : 'accepted';
      } else {
        overallStatus = 'partial';
      }

      summaries.push({
        file,
        patchId: primary.id,
        sessionId: primary.sessionId,
        hunks: totalHunks,
        status: overallStatus,
        acceptedCount,
        deniedCount,
        acceptedHunks,
        deniedHunks,
      });
    }

    return summaries;
  }

  /** Call when patch data changes — updates the webview. */
  refresh(): void {
    if (!this._view) return;
    const files = this.buildFileList();
    this._view.webview.postMessage({ command: 'updateState', files });
  }

  /**
   * Notify webview that a specific file has changed.
   * Consolidation, temp-file update, and UI refresh are all debounced:
   * they run 100ms after the user stops typing.
   */
  notifyFileChanged(filePath: string): void {
    // Normalize to POSIX path for lookup
    const posixPath = filePath.replace(/\\/g, '/');

    // Check if file is tracked (cheap — no I/O)
    const allFiles = this._diffManager.getAllFiles();
    const isTracked = allFiles.some(f => f === posixPath || f === filePath);
    if (!isTracked) return;

    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
    }
    this._debounceTimer = setTimeout(() => {
      // Consolidate patches: reverse-apply all → git diff → replace with clean patch
      const result = this._diffManager.consolidatePatches(posixPath, this._workspaceRoot);

      if (result.success && !result.hadConflict) {
        // No conflict: update the Before temp file for any open diff editor
        this.updateDiffTempFile(posixPath);
      }
      // If conflict: don't update the Before file (hunk overlap — Before stays as-is)

      // Refresh the webview UI
      this.refresh();
    }, 100);
  }

  /**
   * Re-generate the reverse temp file for a tracked file so that
   * any open VSCode diff editor for this file picks up the change.
   * Uses the same stable temp path as handleOpenDiff.
   *
   * When `git apply --reverse` would conflict (hunk overlap due to
   * manual edits), we preserve the cached Before temp file instead of
   * overwriting it — the consolidation step already updated the patches
   * with preserved hunks, and the diff editor keeps its last-known-good
   * Before view.
   */
  private updateDiffTempFile(filePath: string): void {
    // Check for conflicts BEFORE touching the cached Before temp file
    const hasConflict = this._diffManager.hasConflicts(
      filePath, this._workspaceRoot
    );
    if (hasConflict) {
      // Hunk overlap: keep the cached Before temp file, don't overwrite it
      this.onReverseConflict(filePath);
      return;
    }

    const absPath = path.resolve(this._workspaceRoot, filePath);
    let currentContent = '';
    try {
      currentContent = fs.readFileSync(absPath, 'utf8');
    } catch {
      return; // file doesn't exist — nothing to diff
    }

    const reverseContent = this._diffManager.getReverseContent(
      filePath, this._workspaceRoot
    );
    if (reverseContent === null || reverseContent === currentContent) {
      return; // nothing to show or reverse produced no change
    }

    const safeName = filePath.replace(/[\\/]/g, '_').replace(/[:]/g, '');
    const tmpDir = path.join(os.tmpdir(), 'cc-diff');
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
    const leftPath = path.join(tmpDir, `before_${safeName}`);
    fs.writeFileSync(leftPath, reverseContent, 'utf8');
  }

  // ======================================================================
  // Webview → Extension message handling
  // ======================================================================

  private async handleMessage(msg: any): Promise<void> {
    const { command, file, patchId, hunkId } = msg;

    switch (command) {
      case 'openDiff':
        this.handleOpenDiff(file);
        break;

      case 'acceptFile':
        // Accept all patches for this file
        this.acceptFilePatches(file);
        this.refresh();
        break;

      case 'denyFile': {
        // Deny all patches for this file (newest first)
        const result = this.denyFilePatches(file);
        if (result && !result.success) {
          this.logConflict(file, result.message, result.errorDetail);
          this.showConflictNotification(file, 'file');
        }
        this.refresh();
        break;
      }

      case 'acceptHunk':
        this._diffManager.acceptHunk(patchId, hunkId);
        this.refresh();
        break;

      case 'denyHunk': {
        const result = this._diffManager.denyHunk(patchId, hunkId, this._workspaceRoot);
        if (!result.success) {
          this.logConflict(file, result.message, result.errorDetail);
          this.showConflictNotification(file, 'hunk');
        }
        this.refresh();
        break;
      }

      case 'acceptAll': {
        const answer = await vscode.window.showInformationMessage(
          'Accept all changes in all patches?',
          { modal: true },
          'Accept All'
        );
        if (answer === 'Accept All') {
          this._diffManager.acceptAll();
          this.refresh();
        }
        break;
      }

      case 'denyAll': {
        const answer = await vscode.window.showInformationMessage(
          'Deny (revert) all changes in all patches? This will undo all file modifications.',
          { modal: true },
          'Deny All'
        );
        if (answer === 'Deny All') {
          const results = this._diffManager.denyAll(this._workspaceRoot);
          const conflicts = results.filter(r => !r.success);
          if (conflicts.length > 0) {
            const fileList = conflicts.map(r => r.file).join(', ');
            this._outputChannel.appendLine(
              `[CONFLICT] denyAll: ${conflicts.length}/${results.length} patch(es) had conflicts: ${fileList}`
            );
            for (const c of conflicts) {
              this._outputChannel.appendLine(`  ─ ${c.file} (${c.patchId})`);
              this._outputChannel.appendLine(`    ${c.message}`);
              if (c.errorDetail) {
                const indented = c.errorDetail.split('\n').map((l: string) => `    | ${l}`).join('\n');
                this._outputChannel.appendLine(indented);
              }
            }
            this.showConflictNotification(
              `${conflicts.length}/${results.length} patch(es)`,
              'batch'
            );
          }
          this.refresh();
        }
        break;
      }

      case 'refresh':
        this._diffManager.loadPatches(this._workspaceRoot);
        this.refresh();
        break;
    }
  }

  /**
   * Accept all patches for a file (mark each patch as accepted).
   */
  private acceptFilePatches(filePath: string): void {
    const patches = this._diffManager.getPatchesForFile(filePath);
    for (const p of patches) {
      this._diffManager.acceptPatch(p.id);
    }
  }

  /**
   * Deny all patches for a file, newest first.
   */
  private denyFilePatches(filePath: string): { success: boolean; message: string; errorDetail?: string } | null {
    const patches = this._diffManager.getPatchesForFile(filePath);
    // Process newest first
    const reversed = [...patches].reverse();

    let lastError: { success: boolean; message: string; errorDetail?: string } | null = null;

    for (const p of reversed) {
      if (p.status === 'accepted' || p.status === 'denied') continue;
      const result = this._diffManager.denyPatch(p.id, this._workspaceRoot);
      if (!result.success) {
        lastError = { success: false, message: result.message, errorDetail: result.errorDetail };
        // Stop on first failure — later patches depend on this one
        return lastError;
      }
    }

    return lastError || { success: true, message: 'All patches reverted' };
  }

  // ======================================================================
  // Conflict notification & logging
  // ======================================================================

  /**
   * Write a structured conflict entry to the Output channel.
   */
  private logConflict(file: string, message: string, errorDetail?: string): void {
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    this._outputChannel.appendLine(`[${timestamp}] [CONFLICT] ${file}`);
    this._outputChannel.appendLine(`  Message: ${message}`);
    if (errorDetail) {
      const indented = errorDetail.split('\n').map((l: string) => `  | ${l}`).join('\n');
      this._outputChannel.appendLine(indented);
    }
  }

  /**
   * Show a conflict popup notification with a "Show Output" button.
   */
  private showConflictNotification(target: string, level: 'file' | 'hunk' | 'batch'): void {
    const label = level === 'batch'
      ? `${target} could not be cleanly reverted — check Output for details`
      : level === 'hunk'
        ? `Hunk in "${target}" could not be reverted — file was modified. Check Output for details`
        : `"${target}" could not be cleanly reverted — file was modified. Check Output for details`;

    this._outputChannel.show(/* preserveFocus */ false);

    vscode.window.showErrorMessage(
      `CC Diff: ${label}`,
      'Show Output',
      'Dismiss'
    ).then(choice => {
      if (choice === 'Show Output') {
        this._outputChannel.show(/* preserveFocus */ false);
      }
    });
  }

  /**
   * Called when `git apply --reverse` fails during a diff-refresh.
   * Deduplicates: only one notification per file within a 5-second window.
   */
  private onReverseConflict(filePath: string): void {
    if (this._conflictNotified.has(filePath)) return;
    this._conflictNotified.add(filePath);

    setTimeout(() => this._conflictNotified.delete(filePath), 5000);

    const detail = this._diffManager.getReverseConflictDetail(
      filePath, this._workspaceRoot
    );

    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    this._outputChannel.appendLine(
      `[${timestamp}] [CONFLICT] diff refresh: "${filePath}" — git apply --reverse 冲突，文件已被手动修改`
    );
    if (detail) {
      const indented = detail.split('\n').map((l: string) => `  | ${l}`).join('\n');
      this._outputChannel.appendLine(indented);
    }

    this._outputChannel.show(/* preserveFocus */ true);

    vscode.window.showErrorMessage(
      `CC Diff: "${path.basename(filePath)}" 已被手动修改 — diff 预览可能不准确。\n\ngit apply --reverse 冲突，详情请查看「输出」面板。`,
      'Show Output',
      'Dismiss'
    ).then(choice => {
      if (choice === 'Show Output') {
        this._outputChannel.show(/* preserveFocus */ false);
      }
    });
  }

  // ======================================================================
  // Diff Editor
  // ======================================================================

  private async handleOpenDiff(filePath: string): Promise<void> {
    // Consolidate before showing diff to ensure patch is up-to-date
    const consResult = this._diffManager.consolidatePatches(filePath, this._workspaceRoot);
    if (!consResult.success) {
      vscode.window.showWarningMessage(`CC Diff: Failed to consolidate patches for "${filePath}".`);
      return;
    }

    const reverseContent = this._diffManager.getReverseContent(
      filePath, this._workspaceRoot
    );

    if (reverseContent === null) {
      vscode.window.showWarningMessage(`CC Diff: File "${filePath}" not found in any patch.`);
      return;
    }

    const absPath = path.resolve(this._workspaceRoot, filePath);
    let currentContent = '';
    try {
      currentContent = fs.readFileSync(absPath, 'utf8');
    } catch { /* file may not exist */ }

    // If the file was manually edited and the reverse patch no longer applies
    // cleanly, getReverseContent returns currentContent — keep the cached
    // Before temp file instead of overwriting it with currentContent.
    const tmpDir = path.join(os.tmpdir(), 'cc-diff');
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
    const safeName = filePath.replace(/[\\/]/g, '_').replace(/[:]/g, '');
    const leftPath = path.join(tmpDir, `before_${safeName}`);

    if (currentContent && reverseContent === currentContent) {
      const hasConflict = this._diffManager.hasConflicts(filePath, this._workspaceRoot);
      if (hasConflict) {
        this._outputChannel.appendLine(
          `[CONFLICT] handleOpenDiff: "${filePath}" — reverse patch cannot be applied cleanly (file was modified)`
        );
        this._outputChannel.show(/* preserveFocus */ true);
        vscode.window.showErrorMessage(
          `CC Diff: "${path.basename(filePath)}" was modified after the diff was generated — the "before" view may be inaccurate. Check Output for details.`,
          'Show Output',
          'Dismiss'
        ).then(choice => {
          if (choice === 'Show Output') {
            this._outputChannel.show(/* preserveFocus */ false);
          }
        });
        // Keep the cached Before temp file if it exists; if not,
        // write reverseContent (currentContent) as the least-bad fallback.
        if (!fs.existsSync(leftPath)) {
          fs.writeFileSync(leftPath, reverseContent, 'utf8');
        }
      } else {
        fs.writeFileSync(leftPath, reverseContent, 'utf8');
      }
    } else {
      fs.writeFileSync(leftPath, reverseContent, 'utf8');
    }

    const leftUri = vscode.Uri.file(leftPath);
    const rightUri = vscode.Uri.file(absPath);

    const title = `CC Diff: ${path.basename(filePath)} (Before ↔ Current)`;

    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title, {
      preview: true,
      preserveFocus: false,
    });
  }

  // ======================================================================
  // HTML generation
  // ======================================================================

  private buildHtml(initialFiles?: FileSummary[]): string {
    const initialJson = JSON.stringify(initialFiles || []);
    try {
      const templatePath = resolveWebviewTemplatePath();
      let html = fs.readFileSync(templatePath, 'utf8');
      return html.replace('__INITIAL_FILES__', initialJson);
    } catch (error) {
      this._outputChannel.appendLine(`[ERROR] Failed to load webview template: ${error}`);
      return `<!DOCTYPE html><html><body><pre>Failed to load webview template.</pre></body></html>`;
    }
  }

}
