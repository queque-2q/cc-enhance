import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { DiffManager, type SessionData, type FileEntry } from './DiffManager';

// ======================================================================
// Types for webview communication
// ======================================================================

interface FileSummary {
  file: string;
  hunks: number;
  status: string;
  acceptedCount: number;
  deniedCount: number;
}

interface SessionSummary {
  sessionId: string;
  timestamp: number;
  files: FileSummary[];
  complete: boolean;
}

// ======================================================================
// WebviewProvider
// ======================================================================

export class WebviewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _workspaceRoot: string;
  private _diffManager: DiffManager;
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(workspaceRoot: string, diffManager: DiffManager) {
    this._workspaceRoot = workspaceRoot;
    this._diffManager = diffManager;
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

    webviewView.webview.html = this.buildHtml();
    webviewView.webview.onDidReceiveMessage(this.handleMessage.bind(this));

    // Initial state
    this.refresh();
  }

  /** Call when session data changes — updates the webview. */
  refresh(): void {
    if (!this._view) return;
    const sessions = this._diffManager.getAllSessions();
    const summaries: SessionSummary[] = sessions.map(s => ({
      sessionId: s.sessionId,
      timestamp: s.timestamp,
      files: [...s.files.values()].map(f => ({
        file: f.file,
        hunks: f.hunks.length,
        status: f.status,
        acceptedCount: f.acceptedHunks.size,
        deniedCount: f.deniedHunks.size,
      })),
      complete: this._diffManager.isSessionComplete(s.sessionId),
    }));
    this._view.webview.postMessage({ command: 'updateState', sessions: summaries });
  }

  /** Notify webview that a specific file has changed (100ms debounced). */
  notifyFileChanged(filePath: string): void {
    // Normalize to POSIX path for lookup (DiffManager keys are POSIX paths)
    const posixPath = filePath.replace(/\\/g, '/');

    // Check if file is tracked in any session
    const sessions = this._diffManager.getAllSessions();
    const isTracked = sessions.some(s => s.files.has(posixPath) || s.files.has(filePath));
    if (!isTracked) return;

    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
    }
    this._debounceTimer = setTimeout(() => {
      this.refresh();
    }, 100);
  }

  // ======================================================================
  // Webview → Extension message handling
  // ======================================================================

  private async handleMessage(msg: any): Promise<void> {
    const { command, file, sessionId, hunkId } = msg;

    switch (command) {
      case 'openDiff':
        this.handleOpenDiff(file, sessionId);
        break;

      case 'acceptFile':
        this._diffManager.acceptFile(sessionId, file);
        this.refresh();
        break;

      case 'denyFile': {
        const result = this._diffManager.denyFile(sessionId, file, this._workspaceRoot);
        if (!result.success) {
          vscode.window.showWarningMessage(`CC Diff: ${result.message}`);
        }
        this.refresh();
        break;
      }

      case 'acceptHunk':
        this._diffManager.acceptHunk(sessionId, file, hunkId);
        this.refresh();
        break;

      case 'denyHunk': {
        const result = this._diffManager.denyHunk(sessionId, file, hunkId, this._workspaceRoot);
        if (!result.success) {
          vscode.window.showWarningMessage(`CC Diff: ${result.message}`);
        }
        this.refresh();
        break;
      }

      case 'acceptAll': {
        // Confirmation
        const answer = await vscode.window.showInformationMessage(
          `Accept all changes in session ${sessionId}?`,
          { modal: true },
          'Accept All'
        );
        if (answer === 'Accept All') {
          this._diffManager.acceptAll(sessionId);
          this.refresh();
        }
        break;
      }

      case 'denyAll': {
        const answer = await vscode.window.showInformationMessage(
          `Deny (revert) all changes in session ${sessionId}? This will undo all file modifications.`,
          { modal: true },
          'Deny All'
        );
        if (answer === 'Deny All') {
          this._diffManager.denyAll(sessionId, this._workspaceRoot);
          this.refresh();
        }
        break;
      }

      case 'refresh':
        this._diffManager.loadSessions(this._workspaceRoot);
        this.refresh();
        break;
    }
  }

  // ======================================================================
  // Diff Editor
  // ======================================================================

  private async handleOpenDiff(filePath: string, sessionId: string): Promise<void> {
    const reverseContent = this._diffManager.getReverseContent(
      filePath, this._workspaceRoot, sessionId
    );

    if (reverseContent === null) {
      vscode.window.showWarningMessage(`CC Diff: File "${filePath}" not found in session.`);
      return;
    }

    const absPath = path.resolve(this._workspaceRoot, filePath);

    // Create a temp file with the reversed content (left side)
    const tmpDir = path.join(os.tmpdir(), 'cc-diff');
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }

    // Use a stable temp file name so the diff editor can track it
    const safeName = filePath.replace(/[\\/]/g, '_').replace(/[:]/g, '');
    const leftPath = path.join(tmpDir, `before_${safeName}`);
    fs.writeFileSync(leftPath, reverseContent, 'utf8');

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

  private buildHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CC Diff</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--vscode-font-family);
      font-size: 13px;
      color: var(--vscode-sideBar-foreground);
      background: var(--vscode-sideBar-background);
      padding: 0;
      user-select: none;
    }

    .header {
      padding: 12px 16px 8px;
      border-bottom: 1px solid var(--vscode-sideBar-border);
    }
    .header-title {
      font-size: 14px;
      font-weight: 600;
    }
    .header-subtitle {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-top: 2px;
    }

    .session-block {
      border-bottom: 1px solid var(--vscode-sideBar-border);
    }

    .session-header {
      padding: 8px 16px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .file-item {
      padding: 8px 16px;
      cursor: pointer;
      transition: background 0.15s ease;
    }
    .file-item:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .file-item.processed {
      opacity: 0.4;
      text-decoration: line-through;
      transition: opacity 0.3s ease, text-decoration 0.3s ease;
    }

    .file-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .file-name {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
    }
    .file-meta {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
    }

    .hunk-bar {
      margin-top: 4px;
      display: flex;
      gap: 4px;
    }
    .hunk-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--vscode-descriptionForeground);
    }
    .hunk-dot.accepted {
      background: var(--vscode-terminal-ansiGreen);
    }
    .hunk-dot.denied {
      background: var(--vscode-terminal-ansiRed);
    }

    .actions {
      display: flex;
      gap: 8px;
      margin-top: 6px;
    }
    .btn {
      font-family: var(--vscode-font-family);
      font-size: 11px;
      padding: 2px 10px;
      border: 1px solid var(--vscode-sideBar-border);
      background: transparent;
      color: var(--vscode-sideBar-foreground);
      cursor: pointer;
      border-radius: 3px;
    }
    .btn:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .btn.accept {
      color: var(--vscode-terminal-ansiGreen);
    }
    .btn.deny {
      color: var(--vscode-terminal-ansiRed);
    }
    .btn:disabled {
      opacity: 0.3;
      cursor: default;
    }

    .footer {
      padding: 10px 16px;
      border-top: 1px solid var(--vscode-sideBar-border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .footer .btn {
      flex: 1;
      padding: 4px 0;
      text-align: center;
      font-size: 12px;
      font-weight: 600;
    }
    .footer-progress {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      text-align: center;
      white-space: nowrap;
    }

    .empty-state {
      padding: 40px 16px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
      font-size: 13px;
    }

    .conflict-badge {
      color: var(--vscode-terminal-ansiYellow);
      font-size: 11px;
      margin-left: 4px;
    }
  </style>
</head>
<body>
  <div id="root"></div>
  <script>
    const vscode = acquireVsCodeApi();

    let state = { sessions: [] };

    function render() {
      const root = document.getElementById('root');
      const sessions = state.sessions;

      if (sessions.length === 0) {
        root.innerHTML = '<div class="empty-state">No changes to review</div>';
        return;
      }

      let activeSessions = sessions.filter(s => !s.complete);
      let completedSessions = sessions.filter(s => s.complete);

      let html = '';

      // Active sessions
      for (const session of activeSessions) {
        html += renderSession(session);
      }

      // Completed sessions
      if (completedSessions.length > 0) {
        html += '<div class="session-header">Completed (auto-clean in 24h)</div>';
        for (const session of completedSessions) {
          html += renderSession(session);
        }
      }

      root.innerHTML = html;
      attachListeners();
    }

    function renderSession(session) {
      const date = new Date(session.timestamp);
      const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const dateStr = date.toLocaleDateString();
      const pendingCount = session.files.filter(f => f.status === 'pending' || f.status === 'partial').length;

      let html = '<div class="session-block">';
      html += '<div class="session-header">Session ' + esc(session.sessionId.substring(0, 12)) + ' &middot; ' + dateStr + ' ' + timeStr + ' &middot; ' + pendingCount + ' files</div>';

      for (const file of session.files) {
        const isDone = file.status === 'accepted' || file.status === 'denied';
        html += '<div class="file-item' + (isDone ? ' processed' : '') + '" data-action="openDiff" data-file="' + escAttr(file.file) + '" data-session="' + escAttr(session.sessionId) + '">';
        html += '<div class="file-row">';
        html += '<span class="file-name">' + esc(file.file) + '</span>';
        html += '<span class="file-meta">' + file.hunks + ' hunks</span>';
        html += '</div>';

        // Hunk dots
        if (file.hunks > 1) {
          html += '<div class="hunk-bar">';
          for (let i = 0; i < file.hunks; i++) {
            let cls = 'hunk-dot';
            // acceptedHunks/deniedHunks are arrays from JSON serialization
            if (file.acceptedHunks !== undefined && file.acceptedHunks.includes(i)) cls += ' accepted';
            if (file.deniedHunks !== undefined && file.deniedHunks.includes(i)) cls += ' denied';
            html += '<span class="' + cls + '"></span>';
          }
          html += '</div>';
        }

        // Action buttons (only if not already processed)
        if (!isDone) {
          html += '<div class="actions">';
          html += '<button class="btn accept" data-action="acceptFile" data-file="' + escAttr(file.file) + '" data-session="' + escAttr(session.sessionId) + '">Accept</button>';
          html += '<button class="btn deny" data-action="denyFile" data-file="' + escAttr(file.file) + '" data-session="' + escAttr(session.sessionId) + '">Deny</button>';
          html += '</div>';
        }

        html += '</div>';
      }

      // Session footer
      if (pendingCount > 0 && !session.complete) {
        const totalFiles = session.files.length;
        const processedFiles = session.files.filter(f => f.status === 'accepted' || f.status === 'denied').length;
        html += '<div class="footer">';
        html += '<button class="btn accept" data-action="acceptAll" data-session="' + escAttr(session.sessionId) + '">Accept All</button>';
        html += '<span class="footer-progress">' + processedFiles + '/' + totalFiles + ' reviewed</span>';
        html += '<button class="btn deny" data-action="denyAll" data-session="' + escAttr(session.sessionId) + '">Deny All</button>';
        html += '</div>';
      }

      html += '</div>'; // .session-block
      return html;
    }

    function esc(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function escAttr(s) {
      return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function attachListeners() {
      document.querySelectorAll('[data-action]').forEach(el => {
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          const action = el.dataset.action;
          const file = el.dataset.file;
          const session = el.dataset.session;

          if (action === 'openDiff') {
            vscode.postMessage({ command: 'openDiff', file, sessionId: session });
          } else if (action === 'acceptFile') {
            vscode.postMessage({ command: 'acceptFile', file, sessionId: session });
          } else if (action === 'denyFile') {
            vscode.postMessage({ command: 'denyFile', file, sessionId: session });
          } else if (action === 'acceptAll') {
            vscode.postMessage({ command: 'acceptAll', sessionId: session });
          } else if (action === 'denyAll') {
            vscode.postMessage({ command: 'denyAll', sessionId: session });
          }
        });
      });
    }

    // --- Message handling from extension ---
    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg.command === 'updateState') {
        state.sessions = msg.sessions;
        render();
      }
    });

    // Initial render
    render();
  </script>
</body>
</html>`;
  }
}
