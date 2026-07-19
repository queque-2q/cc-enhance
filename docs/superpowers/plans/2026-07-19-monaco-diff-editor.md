# Monaco Diff Editor 重构实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 diff 查看体验从原生编辑器+CodeLens 重构为基于 Monaco Diff Editor 的 WebviewPanel，每个 hunk 下方内嵌 Accept/Deny 按钮。

**Architecture:** 新建 `MonacoDiffProvider` 管理 Monaco WebviewPanel，`monaco-diff.html` 内嵌 Monaco Diff Editor。`SnapshotManager` 数据层和 `WebviewProvider` 侧边栏保持不变。删除 `DiffEditorManager`、`DiffPanelProvider`、`diff.html`。

**Tech Stack:** TypeScript strict, VSCode API ^1.85, monaco-editor ^0.45.0 (AMD loader), Vanilla JS webview

**Spec:** [2026-07-19-monaco-diff-editor-design.md](../specs/2026-07-19-monaco-diff-editor-design.md)

## Global Constraints

- Webview CSS 绝不硬编码颜色，必须使用 `var(--vscode-*)` CSS 变量
- 仅在 CC Diff 侧边栏点击文件时打开 Monaco WebviewPanel，其他地方保持原生编辑器
- Monaco AMD loader 方式加载，不引入 webpack/esbuild
- Monaco 资源从 `node_modules/monaco-editor/min/vs` 复制到 `out/webview/vs`
- `tcsr` 编译 → `copy-webview.js` 复制资源 → VSIX 打包

---

## 文件结构

| 文件 | 责任 | 变更 |
|------|------|------|
| `src/MonacoDiffProvider.ts` | Monaco WebviewPanel 生命周期、消息处理、操作委托 | **新建** |
| `src/webview/monaco-diff.html` | Monaco Diff Editor 渲染、IContentWidget 按钮、主题同步、模式切换 | **新建** |
| `scripts/copy-webview.js` | 复制 Monaco VS 资源 + HTML 模板到 `out/` | **新建** |
| `src/extension.ts` | 移除 CodeLens/InlayHints，DiffEditorManager → MonacoDiffProvider | **修改** |
| `src/WebviewProvider.ts` | DiffEditorManager 类型 → MonacoDiffProvider | **修改** |
| `package.json` | 新增 monaco-editor 依赖、build/copy-webview 脚本 | **修改** |
| `src/DiffEditorManager.ts` | — | **删除** |
| `src/DiffPanelProvider.ts` | — | **删除** |
| `src/webview/diff.html` | — | **删除** |

---

### Task 1: 安装 monaco-editor 并搭建构建基础设施

**Files:**
- Modify: `package.json`
- Create: `scripts/copy-webview.js`

**Interfaces:**
- Consumes: (none — first task)
- Produces:
  - `npm run copy-webview` script
  - `npm run build` script = compile + copy-webview
  - `node_modules/monaco-editor/min/vs/` available for copying
  - `out/webview/vs/` directory structure in build output

- [ ] **Step 1: 安装 monaco-editor**

```bash
npm install --save-dev monaco-editor@^0.45.0
```

- [ ] **Step 2: 更新 package.json scripts**

将 `package.json` 中的 scripts 块替换为：

```json
"scripts": {
  "vscode:prepublish": "npm run build",
  "compile": "tsc -p ./",
  "copy-webview": "node scripts/copy-webview.js",
  "build": "npm run compile && npm run copy-webview",
  "watch": "tsc -watch -p ./",
  "package": "vsce package"
}
```

- [ ] **Step 3: 创建 scripts/copy-webview.js**

```js
// scripts/copy-webview.js
// 复制 webview HTML 模板和 Monaco VS 资源到 out/ 目录

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_WEBVIEW = path.join(ROOT, 'out', 'webview');

// 确保输出目录存在
fs.mkdirSync(OUT_WEBVIEW, { recursive: true });

// 1. 复制 HTML 模板
const srcWebviewDir = path.join(ROOT, 'src', 'webview');
for (const name of fs.readdirSync(srcWebviewDir)) {
  if (name.endsWith('.html')) {
    const src = path.join(srcWebviewDir, name);
    const dst = path.join(OUT_WEBVIEW, name);
    fs.copyFileSync(src, dst);
    console.log(`  copied: src/webview/${name} -> out/webview/${name}`);
  }
}

// 2. 复制 Monaco VS 资源
const monacoSrc = path.join(ROOT, 'node_modules', 'monaco-editor', 'min', 'vs');
const monacoDst = path.join(OUT_WEBVIEW, 'vs');

if (!fs.existsSync(monacoSrc)) {
  console.error('ERROR: monaco-editor not found. Run: npm install');
  process.exit(1);
}

copyRecursive(monacoSrc, monacoDst);

const stats = countFiles(monacoDst);
console.log(`  copied: ${stats.files} files (${(stats.size / 1024 / 1024).toFixed(1)} MB) -> out/webview/vs/`);

// ── helpers ────────────────────────────────────────────────

function copyRecursive(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyRecursive(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

function countFiles(dir) {
  let size = 0, count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = countFiles(p);
      count += sub.files;
      size += sub.size;
    } else {
      count++;
      size += fs.statSync(p).size;
    }
  }
  return { size, files: count };
}
```

- [ ] **Step 4: 运行构建，验证 Monaco 资源复制成功**

```bash
npm run build
```

Expected: `out/webview/vs/` 目录存在，包含 `loader.js`、`editor/editor.main.js` 等文件约 15MB。

- [ ] **Step 5: 确认 .vscodeignore 不需要修改**

当前 `.vscodeignore` 内容为 `src/**`。`out/` 默认包含在 VSIX 中。`node_modules/` 默认被 `vsce` 排除。Monaco 资源在 `out/webview/vs/`，会被打包进 VSIX。无需修改。

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json scripts/copy-webview.js
git commit -m "chore: add monaco-editor dependency and build infrastructure"
```

---

### Task 2: 创建 Monaco Diff Webview 模板

**Files:**
- Create: `src/webview/monaco-diff.html`

**Interfaces:**
- Consumes: `out/webview/vs/` Monaco resources (from Task 1)
- Produces:
  - HTML 模板文件，无数据注入（数据通过 postMessage 发送）
  - Expects messages: `renderDiff`, `diffUpdated`, `allProcessed`
  - Sends messages: `ready`, `acceptHunk`, `denyHunk`, `acceptAll`, `denyAll`, `switchMode`

- [ ] **Step 1: 创建 src/webview/monaco-diff.html**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CC Diff</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: var(--vscode-editor-background, #1e1e1e);
      --fg: var(--vscode-editor-foreground, #d4d4d4);
      --muted: var(--vscode-descriptionForeground, #888);
      --border: var(--vscode-panel-border, #333);
      --accent: var(--vscode-textLink-foreground, #3794ff);
      --green: var(--vscode-terminal-ansiGreen, #23a952);
      --red: var(--vscode-terminal-ansiRed, #e54b4b);
      --btn-bg: var(--vscode-button-background, #0e639c);
      --btn-fg: var(--vscode-button-foreground, #fff);
      --btn-secondary-bg: var(--vscode-button-secondaryBackground, #3a3d41);
      --font: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
      --mono: var(--vscode-editor-font-family, 'Cascadia Code', 'Consolas', 'Courier New', monospace);
    }
    html, body {
      height: 100%;
      display: flex;
      flex-direction: column;
      font-family: var(--font);
      font-size: 13px;
      color: var(--fg);
      background: var(--bg);
      overflow: hidden;
    }

    /* ── Toolbar ──────────────────────────── */
    .toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    .toolbar-filename {
      font-family: var(--mono);
      font-size: 12px;
      font-weight: 600;
      flex: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .btn-group { display: flex; gap: 4px; }
    .btn {
      font-family: var(--font);
      font-size: 11px;
      font-weight: 600;
      padding: 2px 10px;
      height: 22px;
      border: 1px solid;
      border-radius: 3px;
      cursor: pointer;
      background: transparent;
      white-space: nowrap;
      transition: background 0.12s ease;
    }
    .btn-accept {
      color: var(--green);
      border-color: var(--green);
    }
    .btn-accept:hover,
    .btn-accept.active {
      background: var(--green);
      color: var(--btn-fg);
    }
    .btn-deny {
      color: var(--red);
      border-color: var(--red);
    }
    .btn-deny:hover,
    .btn-deny.active {
      background: var(--red);
      color: var(--btn-fg);
    }
    .btn-mode {
      color: var(--muted);
      border-color: var(--border);
      font-size: 10px;
    }
    .btn-mode.active {
      color: var(--fg);
      background: var(--btn-secondary-bg);
      border-color: var(--accent);
    }

    /* ── Monaco container ──────────────────── */
    #editor-container {
      flex: 1;
      min-height: 0;
    }

    /* ── Footer ────────────────────────────── */
    .footer {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      padding: 4px 12px;
      border-top: 1px solid var(--border);
      flex-shrink: 0;
      font-size: 11px;
      color: var(--muted);
    }

    /* ── Loading / Empty ───────────────────── */
    .overlay {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 100;
    }
    .overlay-text {
      font-size: 14px;
      color: var(--muted);
    }

    /* ── Hunk action widget ────────────────── */
    .hunk-actions {
      display: inline-flex;
      gap: 4px;
      padding: 1px 4px;
      margin-left: 12px;
      vertical-align: middle;
    }
    .hunk-actions .btn-hunk {
      font-family: var(--font);
      font-size: 10px;
      font-weight: 600;
      padding: 1px 8px;
      height: 18px;
      line-height: 16px;
      border: 1px solid;
      border-radius: 3px;
      cursor: pointer;
      background: transparent;
      white-space: nowrap;
      transition: background 0.12s ease;
    }
    .hunk-actions .btn-hunk.btn-accept { color: var(--green); border-color: var(--green); }
    .hunk-actions .btn-hunk.btn-accept:hover { background: var(--green); color: var(--btn-fg); }
    .hunk-actions .btn-hunk.btn-deny { color: var(--red); border-color: var(--red); }
    .hunk-actions .btn-hunk.btn-deny:hover { background: var(--red); color: var(--btn-fg); }
  </style>
</head>
<body>
  <!-- Toolbar -->
  <div class="toolbar" id="toolbar">
    <span class="toolbar-filename" id="filename">CC Diff</span>
    <span style="font-size:10px;color:var(--muted)" id="hunk-count"></span>
    <div class="btn-group">
      <button class="btn btn-mode active" id="btn-sidebyside" title="Side-by-side view">Side-by-side</button>
      <button class="btn btn-mode" id="btn-inline" title="Inline view">Inline</button>
    </div>
    <div class="btn-group">
      <button class="btn btn-accept" id="btn-accept-all">Accept All</button>
      <button class="btn btn-deny" id="btn-deny-all">Deny All</button>
    </div>
  </div>

  <!-- Monaco diff editor -->
  <div id="editor-container">
    <div class="overlay" id="loading-overlay">
      <span class="overlay-text">Loading diff editor...</span>
    </div>
  </div>

  <!-- Footer -->
  <div class="footer" id="footer">
    <span id="footer-text"></span>
  </div>

  <script src="vs/loader.js"></script>
  <script>
    // ==================================================================
    // VSCode API
    // ==================================================================
    var vscode;
    try {
      vscode = acquireVsCodeApi();
    } catch (e) {
      vscode = { postMessage: function(m) { console.log('postMessage:', m); } };
    }

    // ==================================================================
    // State
    // ==================================================================
    var state = {
      file: '',
      hunks: [],
      diffEditor: null,
      originalModel: null,
      modifiedModel: null,
      contentWidgets: [],
      mode: 'side-by-side'  // 'side-by-side' | 'inline'
    };

    // ==================================================================
    // Monaco bootstrap
    // ==================================================================
    var MONACO_LOADED = false;

    require.config({
      paths: { vs: 'vs' }
    });

    require(['vs/editor/editor.main'], function () {
      MONACO_LOADED = true;
      hideLoading();

      // 如果 renderDiff 在加载完成前到达，现在可以渲染
      if (state._pendingRender) {
        renderDiff(state._pendingRender);
        state._pendingRender = null;
      }
    });

    function hideLoading() {
      var overlay = document.getElementById('loading-overlay');
      if (overlay) overlay.style.display = 'none';
    }

    // ==================================================================
    // Theme detection
    // ==================================================================
    function detectMonacoTheme() {
      var bodyClass = document.body.className || '';
      if (bodyClass.indexOf('vscode-high-contrast') !== -1) return 'hc-black';
      if (bodyClass.indexOf('vscode-dark') !== -1) return 'vs-dark';
      return 'vs';
    }

    function syncTheme() {
      if (!state.diffEditor) return;
      var theme = detectMonacoTheme();
      monaco.editor.setTheme(theme);
    }

    // ==================================================================
    // Render diff
    // ==================================================================
    function renderDiff(data) {
      // If Monaco not loaded yet, defer
      if (!MONACO_LOADED) {
        state._pendingRender = data;
        return;
      }

      state.file = data.file;
      state.hunks = data.hunks;

      var container = document.getElementById('editor-container');

      // Update UI
      document.getElementById('filename').textContent = 'CC Diff: ' + (data.file || '');
      updateToolbar(data.hunks.length);

      var original = data.original || '';
      var modified = data.modified || '';

      // Dispose old content widgets
      disposeContentWidgets();

      if (state.diffEditor) {
        // Update existing models
        state.originalModel.setValue(original);
        state.modifiedModel.setValue(modified);
      } else {
        // First render: create models + diff editor
        state.originalModel = monaco.editor.createModel(original);
        state.modifiedModel = monaco.editor.createModel(modified);

        state.diffEditor = monaco.editor.createDiffEditor(container, {
          enableSplitViewResizing: true,
          renderSideBySide: state.mode === 'side-by-side',
          readOnly: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          glyphMargin: false,
          lineNumbers: 'on',
          renderIndicators: false,
          originalEditable: false,
          automaticLayout: true,
          ignoreTrimWhitespace: false,
        });

        state.diffEditor.setModel({
          original: state.originalModel,
          modified: state.modifiedModel,
        });

        syncTheme();
      }

      // Apply mode setting
      if (state.diffEditor) {
        state.diffEditor.updateOptions({
          renderSideBySide: state.mode === 'side-by-side'
        });
      }

      // Create content widgets for each hunk
      var modifiedEditor = state.diffEditor.getModifiedEditor();
      for (var i = 0; i < data.hunks.length; i++) {
        addHunkWidget(modifiedEditor, data.hunks[i]);
      }

      // Update footer
      document.getElementById('footer-text').textContent =
        data.hunks.length + ' hunk(s) remaining';
    }

    function updateDiff(data) {
      // Same flow as renderDiff but without re-creating editor
      renderDiff(data);
    }

    // ==================================================================
    // Content widgets
    // ==================================================================
    function addHunkWidget(editor, hunk) {
      // Parse hunk header to find position
      // Format: @@ -oldStart,oldCount +newStart,newCount @@
      var m = hunk.header.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (!m) return;

      var newStart = parseInt(m[1], 10);
      var newCount = m[2] ? parseInt(m[2], 10) : 1;

      // Place widget at the last line of the hunk in modified editor
      var position = { lineNumber: newStart + newCount - 1, column: Number.MAX_SAFE_INTEGER };

      var widget = {
        hunkId: hunk.id,
        getId: function () { return 'hunk-actions-' + hunk.id; },
        getDomNode: function () {
          var el = document.createElement('div');
          el.className = 'hunk-actions';
          el.style.position = 'relative';
          el.style.zIndex = '10';

          var acceptBtn = document.createElement('button');
          acceptBtn.className = 'btn-hunk btn-accept';
          acceptBtn.textContent = 'Accept';
          acceptBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            vscode.postMessage({ command: 'acceptHunk', hunkId: hunk.id });
          });

          var denyBtn = document.createElement('button');
          denyBtn.className = 'btn-hunk btn-deny';
          denyBtn.textContent = 'Deny';
          denyBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            vscode.postMessage({ command: 'denyHunk', hunkId: hunk.id });
          });

          el.appendChild(acceptBtn);
          el.appendChild(denyBtn);
          return el;
        },
        getPosition: function () { return position; },
      };

      editor.addContentWidget(widget);
      state.contentWidgets.push(widget);
    }

    function disposeContentWidgets() {
      if (!state.diffEditor) return;
      var editor = state.diffEditor.getModifiedEditor();
      for (var i = 0; i < state.contentWidgets.length; i++) {
        try {
          editor.removeContentWidget(state.contentWidgets[i]);
        } catch (e) { /* widget may already be removed */ }
      }
      state.contentWidgets = [];
    }

    // ==================================================================
    // UI helpers
    // ==================================================================
    function updateToolbar(hunkCount) {
      document.getElementById('hunk-count').textContent =
        hunkCount > 0 ? hunkCount + ' hunk(s)' : '';
    }

    function setMode(mode) {
      state.mode = mode;
      if (state.diffEditor) {
        state.diffEditor.updateOptions({
          renderSideBySide: mode === 'side-by-side'
        });
      }
      // Update active button
      document.getElementById('btn-sidebyside').classList.toggle('active', mode === 'side-by-side');
      document.getElementById('btn-inline').classList.toggle('active', mode === 'inline');

      vscode.postMessage({ command: 'switchMode', mode: mode });
    }

    // ==================================================================
    // Toolbar events
    // ==================================================================
    document.getElementById('btn-sidebyside').addEventListener('click', function () {
      setMode('side-by-side');
    });
    document.getElementById('btn-inline').addEventListener('click', function () {
      setMode('inline');
    });
    document.getElementById('btn-accept-all').addEventListener('click', function () {
      vscode.postMessage({ command: 'acceptAll' });
    });
    document.getElementById('btn-deny-all').addEventListener('click', function () {
      vscode.postMessage({ command: 'denyAll' });
    });

    // ==================================================================
    // Message handler
    // ==================================================================
    window.addEventListener('message', function (e) {
      var msg = e.data;
      switch (msg.command) {
        case 'renderDiff':
          renderDiff(msg);
          break;
        case 'diffUpdated':
          updateDiff(msg);
          break;
        case 'allProcessed':
          document.getElementById('footer-text').textContent = 'All changes processed.';
          document.getElementById('hunk-count').textContent = '';
          updateToolbar(0);
          disposeContentWidgets();
          break;
      }
    });

    // ==================================================================
    // Theme sync via MutationObserver
    // ==================================================================
    var themeObserver = new MutationObserver(function () {
      syncTheme();
    });
    themeObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['class']
    });

    // ==================================================================
    // Init
    // ==================================================================
    vscode.postMessage({ command: 'ready' });
  </script>
</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add src/webview/monaco-diff.html
git commit -m "feat: add Monaco diff editor webview template"
```

---

### Task 3: 创建 MonacoDiffProvider

**Files:**
- Create: `src/MonacoDiffProvider.ts`

**Interfaces:**
- Consumes:
  - `SnapshotManager` — `getSnapshotContent()`, `computeDiff()`, `acceptHunk()`, `denyHunk()`, `acceptAll()`, `denyAll()`
  - `vscode.WebviewPanel` API
  - `path`, `fs` (Node.js stdlib)
- Produces:
  - `openDiff(filePath: string): void`
  - `acceptAll(filePath: string): Promise<void>`
  - `denyAll(filePath: string): Promise<void>`
  - `hasActiveDiff(filePath: string): boolean`
  - `dispose(): void`
  - `onFileProcessed: ((filePath: string) => void) | null`

- [ ] **Step 1: 创建完整的 MonacoDiffProvider**

```ts
// src/MonacoDiffProvider.ts
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SnapshotManager, type HunkData } from './SnapshotManager';

/**
 * 管理基于 Monaco Diff Editor 的 WebviewPanel。
 * 一个 panel 一次显示一个文件，复用已打开的 panel。
 */
export class MonacoDiffProvider {
  private _workspaceRoot: string;
  private _snapshotManager: SnapshotManager;
  private _outputChannel: vscode.OutputChannel;

  private _panel: vscode.WebviewPanel | null = null;
  private _currentFile: string = '';
  private _currentHunks: HunkData[] = [];

  /** Webview 已 ready 时的缓存数据 */
  private _pendingData: {
    file: string;
    original: string;
    modified: string;
    hunks: HunkData[];
  } | null = null;

  /** 当文件所有 hunk 处理完毕时调用 */
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

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  /** 为指定文件打开 Monaco diff view */
  openDiff(filePath: string): void {
    // 如果同一个文件已打开，reveal 即可
    if (this._panel && this._currentFile === filePath) {
      this._panel.reveal();
      return;
    }

    // 获取文件内容
    const snapshotContent = this._snapshotManager.getSnapshotContent(filePath);
    if (snapshotContent === null) {
      vscode.window.showErrorMessage('CC Diff: Snapshot not found for this file.');
      return;
    }

    const absPath = path.resolve(this._workspaceRoot, filePath);
    let currentContent = '';
    try {
      currentContent = fs.readFileSync(absPath, 'utf8');
    } catch {
      // File deleted — treat as empty
    }

    // 计算 hunk
    const hunks = this._snapshotManager.computeDiff(filePath, this._workspaceRoot);
    if (hunks.length === 0) {
      vscode.window.showInformationMessage(
        `CC Diff: No changes to display for "${filePath}".`
      );
      return;
    }

    this._pendingData = {
      file: filePath,
      original: snapshotContent,
      modified: currentContent,
      hunks,
    };

    // 创建或复用 panel
    if (!this._panel) {
      this._panel = vscode.window.createWebviewPanel(
        'cc-diff.monacoDiff',
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
        this._currentHunks = [];
        this._pendingData = null;
      });

      this._panel.webview.onDidReceiveMessage((msg) => {
        this._handleMessage(msg).catch((err) => {
          this._outputChannel.appendLine(
            `[MonacoDiffProvider] unhandled error: ${err}`
          );
        });
      });

      // 加载 HTML
      this._panel.webview.html = this._readTemplate();
    }

    // 更新 title
    this._panel.title = `CC Diff: ${path.basename(filePath)}`;
    this._currentFile = filePath;
    this._currentHunks = hunks;

    // 如果 webview 已经 ready（复用 panel），直接发送数据
    this._sendPendingIfReady();
    this._panel.reveal();
  }

  async acceptAll(filePath: string): Promise<void> {
    this._snapshotManager.acceptAll(filePath);
    if (this._currentFile === filePath) {
      this._panel?.webview.postMessage({ command: 'allProcessed' });
      this._panel?.dispose(); // onDidDispose 清理状态
      this._onFileProcessed?.(filePath);
    }
  }

  async denyAll(filePath: string): Promise<void> {
    const result = this._snapshotManager.denyAll(filePath, this._workspaceRoot);
    if (!result.success) {
      vscode.window.showErrorMessage(
        `CC Diff: Failed to revert "${filePath}" — ${result.error}`
      );
      return;
    }
    if (this._currentFile === filePath) {
      this._panel?.webview.postMessage({ command: 'allProcessed' });
      this._panel?.dispose(); // onDidDispose 清理状态
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
    this._currentHunks = [];
  }

  // ------------------------------------------------------------------
  // Message handling
  // ------------------------------------------------------------------

  private async _handleMessage(msg: any): Promise<void> {
    switch (msg.command) {
      case 'ready':
        this._sendPendingIfReady();
        break;

      case 'acceptHunk': {
        const hunk = this._currentHunks.find(h => h.id === msg.hunkId);
        if (!hunk) return;

        const result = this._snapshotManager.acceptHunk(
          this._currentFile,
          hunk,
          this._workspaceRoot
        );
        if (!result.success) {
          vscode.window.showErrorMessage(
            `CC Diff: Failed to accept hunk — ${result.error}`
          );
          return;
        }
        this._refreshDiff();
        break;
      }

      case 'denyHunk': {
        const hunk = this._currentHunks.find(h => h.id === msg.hunkId);
        if (!hunk) return;

        const result = this._snapshotManager.denyHunk(
          this._currentFile,
          hunk,
          this._workspaceRoot
        );
        if (!result.success) {
          vscode.window.showErrorMessage(
            `CC Diff: Failed to deny hunk — ${result.error}`
          );
          return;
        }
        this._refreshDiff();
        break;
      }

      case 'acceptAll':
        await this.acceptAll(this._currentFile);
        break;

      case 'denyAll':
        await this.denyAll(this._currentFile);
        break;

      case 'switchMode':
        // 仅日志，无操作
        this._outputChannel.appendLine(
          `[MonacoDiffProvider] mode switched to ${msg.mode} for "${this._currentFile}"`
        );
        break;
    }
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  /** 如果 webview ready 且有缓存数据，发送渲染数据 */
  private _sendPendingIfReady(): void {
    if (!this._pendingData || !this._panel) return;

    const data = this._pendingData;
    this._pendingData = null;

    this._panel.webview.postMessage({
      command: 'renderDiff',
      file: data.file,
      original: data.original,
      modified: data.modified,
      hunks: data.hunks,
    });
  }

  /** 重新计算 diff 并推送到 webview */
  private _refreshDiff(): void {
    if (!this._currentFile) return;

    const snapshotContent = this._snapshotManager.getSnapshotContent(this._currentFile);
    if (snapshotContent === null) {
      this._panel?.webview.postMessage({ command: 'allProcessed' });
      if (this._panel) {
        this._panel.dispose(); // onDidDispose 清理状态
      }
      this._onFileProcessed?.(this._currentFile);
      return;
    }

    const absPath = path.resolve(this._workspaceRoot, this._currentFile);
    let currentContent = '';
    try {
      currentContent = fs.readFileSync(absPath, 'utf8');
    } catch {
      // File deleted
    }

    const hunks = this._snapshotManager.computeDiff(this._currentFile, this._workspaceRoot);

    if (hunks.length === 0) {
      // All processed
      this._panel?.webview.postMessage({ command: 'allProcessed' });
      if (this._panel) {
        this._panel.dispose(); // onDidDispose 清理状态
      }
      this._onFileProcessed?.(this._currentFile);
      return;
    }

    this._currentHunks = hunks;

    this._panel?.webview.postMessage({
      command: 'diffUpdated',
      file: this._currentFile,
      original: snapshotContent,
      modified: currentContent,
      hunks,
    });
  }

  /** 读取 monaco-diff.html 模板 */
  private _readTemplate(): string {
    const templatePath = this._resolveTemplatePath();
    if (templatePath && fs.existsSync(templatePath)) {
      return fs.readFileSync(templatePath, 'utf8');
    }
    return `<!DOCTYPE html><html><body><p>Error: Monaco diff template not found.</p></body></html>`;
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
```

- [ ] **Step 2: Commit**

```bash
git add src/MonacoDiffProvider.ts
git commit -m "feat: add MonacoDiffProvider for Monaco-based diff webview"
```

---

### Task 4: 修改现有模块（extension.ts, WebviewProvider.ts, package.ps1）

**Files:**
- Modify: `src/extension.ts`
- Modify: `src/WebviewProvider.ts`
- Modify: `scripts/package.ps1`

**Interfaces:**
- Consumes: `MonacoDiffProvider` (from Task 3)
- Produces: 编译通过，功能衔接正确

- [ ] **Step 1: 修改 src/extension.ts**

变更点：
1. 将 `import { DiffEditorManager } from './DiffEditorManager'` 替换为 `import { MonacoDiffProvider } from './MonacoDiffProvider'`
2. 将 `new DiffEditorManager(...)` 替换为 `new MonacoDiffProvider(...)`
3. 删除 CodeLens 注册（`languages.registerCodeLensProvider` 块）
4. 删除 InlayHints 注册（`languages.registerInlayHintsProvider` 块）
5. 删除 `cc-diff.acceptHunk` 命令（来自 CodeLens）
6. 删除 `cc-diff.denyHunk` 命令（来自 CodeLens）
7. `cc-diff.acceptAllFile` 和 `cc-diff.denyAllFile` 保留（工具条/命令面板仍可用）

精确替换如下：

**替换 import（第 5 行附近）：**

```
old: import { DiffEditorManager } from './DiffEditorManager';
new: import { MonacoDiffProvider } from './MonacoDiffProvider';
```

**替换构造（第 46 行附近）：**

```
old: diffEditorManager = new DiffEditorManager(workspaceRoot, snapshotManager, outputChannel);
new: diffEditorManager = new MonacoDiffProvider(workspaceRoot, snapshotManager, outputChannel);
```

**删除 CodeLens + InlayHints 注册块（第 53-67 行）：**
删除以下代码：

```ts
  // ── CodeLens: per-hunk Accept / Deny ──
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      { scheme: 'file' },
      diffEditorManager
    )
  );

  // ── InlayHints: removed content shown inline in red ──
  context.subscriptions.push(
    vscode.languages.registerInlayHintsProvider(
      { scheme: 'file' },
      diffEditorManager
    )
  );
```

**删除 cc-diff.acceptHunk 和 cc-diff.denyHunk 命令（第 136-150 行）：**
删除以下代码：

```ts
  // Per-hunk commands (called from CodeLens)
  context.subscriptions.push(
    vscode.commands.registerCommand('cc-diff.acceptHunk', async (filePath: string, hunkId: number) => {
      log(`Command: acceptHunk — file="${filePath}" hunkId=${hunkId}`);
      await diffEditorManager.acceptHunk(filePath, hunkId);
      webviewProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cc-diff.denyHunk', async (filePath: string, hunkId: number) => {
      log(`Command: denyHunk — file="${filePath}" hunkId=${hunkId}`);
      await diffEditorManager.denyHunk(filePath, hunkId);
      webviewProvider.refresh();
    })
  );
```

**修改 `diffEditorManager.dispose()` 调用方式（第 47 行附近）：**

```
old: context.subscriptions.push({ dispose: () => diffEditorManager.dispose() });
new: context.subscriptions.push(diffEditorManager);
```

（`MonacoDiffProvider` 的 `dispose()` 不需要包裹在 `{ dispose }` 中，直接 push 即可因为 `Disposable` 接口接受有 `dispose` 方法的对象。）


- [ ] **Step 2: 修改 src/WebviewProvider.ts**

仅需替换 import 和类型声明：

**替换 import（第 5 行）：**

```
old: import { DiffEditorManager } from './DiffEditorManager';
new: import { MonacoDiffProvider } from './MonacoDiffProvider';
```

**替换字段类型声明（第 27 行）：**

```
old: private _diffEditorManager: DiffEditorManager;
new: private _diffEditorManager: MonacoDiffProvider;
```

**替换构造函数参数类型（第 33 行）：**

```
old: diffEditorManager: DiffEditorManager
new: diffEditorManager: MonacoDiffProvider
```

（变量名 `_diffEditorManager` 保持不变，方法调用 `hasActiveDiff`、`acceptAll`、`denyAll` 签名一致，无需改动。）

- [ ] **Step 3: 修改 scripts/package.ps1**

原脚本引用不存在的 `vscode-extension\` 子目录。修改 `npm run build` 调用为在项目根目录执行：

```powershell
# scripts/package.ps1
param(
    [string]$Version
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot | Split-Path -Parent

Write-Host "=== CC Diff Package Builder ===" -ForegroundColor Cyan

# 0. Update version if specified
if ($Version) {
    Write-Host "`nUpdating version to $Version..." -ForegroundColor Yellow
    $pkgPath = Join-Path $root "package.json"
    $pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
    $pkg.version = $Version
    $pkg | ConvertTo-Json -Depth 10 | Set-Content $pkgPath -Encoding UTF8
    Write-Host "  Updated package.json" -ForegroundColor Gray
    $totalSteps = 2
} else {
    $totalSteps = 1
}

# 1. Build (compile + copy webview)
Write-Host "`n[$stepNum/$totalSteps] Building..." -ForegroundColor Yellow
Push-Location $root
npm run build
Pop-Location
$stepNum++

# 2. Package VSIX
Write-Host "`n[$stepNum/$totalSteps] Packaging VSIX..." -ForegroundColor Yellow
Push-Location $root
npx vsce package --allow-missing-repository
Pop-Location

Write-Host "`n=== Done! ===" -ForegroundColor Green
```

（修改变量路径从 `$root\vscode-extension\` 到 `$root\`，将 `tsc -p ./` 替换为 `npm run build`。）

- [ ] **Step 4: 验证编译**

```bash
npm run build
```

Expected: 无 TypeScript 错误，`out/MonacoDiffProvider.js` 存在，`out/webview/monaco-diff.html` 存在。

- [ ] **Step 5: Commit**

```bash
git add src/extension.ts src/WebviewProvider.ts scripts/package.ps1
git commit -m "refactor: wire MonacoDiffProvider, remove CodeLens/InlayHints"
```

---

### Task 5: 删除旧文件

**Files:**
- Delete: `src/DiffEditorManager.ts`
- Delete: `src/DiffPanelProvider.ts`
- Delete: `src/webview/diff.html`

- [ ] **Step 1: 删除旧文件**

```bash
git rm src/DiffEditorManager.ts src/DiffPanelProvider.ts src/webview/diff.html
```

- [ ] **Step 2: 验证编译仍然通过**

```bash
npm run build
```

Expected: 无 TypeScript 错误，`out/DiffEditorManager.js` 和 `out/DiffPanelProvider.js` 不再存在。

- [ ] **Step 3: Commit**

```bash
git commit -m "refactor: remove DiffEditorManager, DiffPanelProvider, diff.html"
```

---

### Task 6: 端到端验证

**Files:**
- (无代码变更，验证已有功能)

- [ ] **Step 1: 类型检查**

```bash
npx tsc --noEmit
```

Expected: 无错误。

- [ ] **Step 2: 检查构建产物完整性**

```bash
ls out/webview/vs/loader.js       && echo "Monaco loader: OK"   || echo "Monaco loader: MISSING"
ls out/webview/vs/editor/editor.main.js && echo "Monaco editor: OK" || echo "Monaco editor: MISSING"
ls out/webview/monaco-diff.html   && echo "Template: OK"        || echo "Template: MISSING"
ls out/webview/index.html         && echo "Sidebar template: OK" || echo "Sidebar template: MISSING"
ls out/MonacoDiffProvider.js      && echo "Provider: OK"         || echo "Provider: MISSING"
```

Expected: 所有文件存在。

- [ ] **Step 3: 手动验证清单**

F5 启动扩展开发宿主后，逐一验证：

1. **快照生成**：运行 Claude Code 编辑文件 → 在 `.claude/cc-diff/snapshots/` 和 `index.json` 中能看到快照
2. **侧边栏**：`index.json` 创建后侧边栏自动刷新，显示有修改的文件
3. **打开 Monaco diff**：侧边栏点击文件 → WebviewPanel 打开，显示 loading → Monaco Diff Editor 渲染，有语法高亮
4. **Side-by-side / Inline 切换**：点击切换按钮 → diff 布局切换
5. **Hunk 按钮可见**：每个 hunk 下方有 Accept / Deny 按钮
6. **Accept hunk**：点击 Accept → hunk 从 diff 中消失，snapshot 文件被更新
7. **Deny hunk**：点击 Deny → hunk 从 diff 中消失，当前文件被回退
8. **Accept All**：点击 Accept All → 所有 diff 消失，面板关闭
9. **Deny All**：点击 Deny All → 所有 diff 消失，面板关闭
10. **主题切换**：VSCode 切换 dark/light/high-contrast → Monaco 跟随
11. **面板复用**：打开文件 A → 关掉面板 → 侧边栏点击文件 B → 同一个面板显示文件 B（没有闪烁新窗口）

- [ ] **Step 4: Commit 所有最终调整**

```bash
git add -A
git commit -m "chore: final adjustments after end-to-end verification"
```
