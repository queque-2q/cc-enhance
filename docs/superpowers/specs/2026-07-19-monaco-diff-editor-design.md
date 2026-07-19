# Monaco Diff Editor 重构设计

**日期**: 2026-07-19
**状态**: 待实现
**分支**: master

## 背景

当前 cc-diff 扩展使用以下方式展示文件修改：

- **DiffEditorManager**：在原生 VSCode 编辑器中用 CodeLens 提供 Accept/Deny 按钮，InlayHints 显示删除内容，Decoration 标记新增行
- **DiffPanelProvider**：自定义 Webview 面板（`diff.html`）用纯 HTML 渲染 diff，contenteditable 支持行内编辑

### 痛点

1. CodeLens 弹出有延迟，按钮不够醒目
2. InlayHints 展示删除内容不直观，长行被截断
3. 缺少语法高亮，与普通编辑体验割裂
4. 没有 side-by-side 对比视图
5. 两条 diff 查看路径（原生编辑器 + 自定义面板）逻辑重复

## 目标

将 diff 查看体验重构为基于 **Monaco Diff Editor** 的 Webview 方案，提供：

- Monaco 原生语法高亮和 diff 渲染
- 每个 hunk 下方内嵌 Accept/Deny 按钮
- Side-by-side / Inline 模式切换
- 仅在 CC Diff 侧边栏点击文件时触发，其他地方保持原生编辑器

## 架构变更

### 模块影响

| 模块 | 变更 |
|------|------|
| `SnapshotManager.ts` | **保留** — 数据层不变 |
| `WebviewProvider.ts` | **保留** — 侧边栏不变，仍调用 `openDiff` |
| `HooksManager.ts` | **保留** — Hook 部署不变 |
| `extension.ts` | **修改** — 移除 CodeLens/InlayHints 注册，DiffEditorManager → MonacoDiffProvider |
| `DiffEditorManager.ts` | **删除** — 原生编辑器+CodeLens 方案 |
| `DiffPanelProvider.ts` | **删除** — 旧 Webview diff 面板 |
| `diff.html` | **删除** — 旧模板 |
| `MonacoDiffProvider.ts` | **新建** — Monaco WebviewPanel 管理器 |
| `monaco-diff.html` | **新建** — Monaco diff 编辑器模板 |

### 交互流程

```
侧边栏点击文件
  → WebviewProvider.handleMessage('openDiff')
  → MonacoDiffProvider.openDiff(filePath)
    → SnapshotManager.getSnapshotContent()  获取 snapshot 原始内容
    → fs.readFileSync(absPath)              获取当前文件内容
    → SnapshotManager.computeDiff()         获取 hunk 列表
    → 创建/复用 WebviewPanel
    → postMessage({ command: 'renderDiff', original, modified, hunks })
  → Monaco webview:
    → monaco.editor.createDiffEditor()
    → originalModel.setValue(original)
    → modifiedModel.setValue(modified)
    → 对每个 hunk 创建 IContentWidget（Accept/Deny 按钮）

用户点击 Accept
  → webview postMessage({ command: 'acceptHunk', hunkId })
  → MonacoDiffProvider → SnapshotManager.acceptHunk()
  → 重新获取 content + computeDiff()
  → postMessage({ command: 'diffUpdated', original, modified, hunks })

用户点击 Deny
  → webview postMessage({ command: 'denyHunk', hunkId })
  → MonacoDiffProvider → SnapshotManager.denyHunk()
  → 重新获取 content + computeDiff()
  → postMessage({ command: 'diffUpdated', original, modified, hunks })
```

## Monaco 加载方案

### AMD Loader 方式

- 依赖 `monaco-editor` npm 包 (^0.45.0)
- 构建时将 `node_modules/monaco-editor/min/vs/` 复制到 `out/webview/vs/`
- Webview HTML 中通过 `<script src="vs/loader.js">` 加载
- 使用 `require(['vs/editor/editor.main'], ...)` 初始化

### Worker 配置

```js
self.MonacoEnvironment = {
  getWorkerUrl: function(moduleId, label) {
    if (label === 'json') return './vs/language/json/json.worker.js';
    if (label === 'css' || label === 'scss' || label === 'less')
      return './vs/language/css/css.worker.js';
    if (label === 'html' || label === 'handlebars' || label === 'razor')
      return './vs/language/html/html.worker.js';
    if (label === 'typescript' || label === 'javascript')
      return './vs/language/typescript/ts.worker.js';
    return './vs/editor/editor.worker.js';
  }
};
```

### 文件体积

Monaco `min/vs/` 约 15MB。对比：GitLens 扩展 ~25MB+，属于 VSCode 生态中可接受的范围。

## Hunk 按钮实现

### 定位策略

使用 `git diff --no-index` 出的 hunk header 确定按钮位置，不依赖 Monaco 内部的 diff 算法结果。

```
hunk header: @@ -10,5 +10,7 @@
                      ↑        ↑
                  newStart  newCount

hunk 在 modified 编辑器中的行范围：[newStart, newStart + newCount - 1]

操作栏位置 = modified 编辑器中第 (newStart + newCount - 1) 行末尾
```

### IContentWidget 实现

每个 hunk 创建一个 `IContentWidget`：

```ts
// monaco-diff.html 中的 JS
{
  getId: () => `hunk-actions-${hunk.id}`,
  getDomNode: () => {
    const el = document.createElement('div');
    el.className = 'hunk-actions';
    el.innerHTML = `
      <button class="btn-accept" data-hunk="${hunk.id}">Accept</button>
      <button class="btn-deny" data-hunk="${hunk.id}">Deny</button>
    `;
    return el;
  },
  getPosition: () => ({
    lineNumber: hunk.newStart + hunk.newCount - 1,
    column: Number.MAX_SAFE_INTEGER,
  }),
}
```

### 视觉效果

**Side-by-side 模式：**

```
┌─ Original (snapshot) ───┬─ Modified (current) ───────┐
│                          │                            │
│  line 10                 │  line 10                   │
│  line 11                 │  + new line A     ← green  │
│  line 12                 │  + new line B     ← green  │
│                          │  ┌────────────────────────┐│
│                          │  │ Accept │ Deny          ││ ← IContentWidget
│                          │  └────────────────────────┘│
│  line 13                 │  line 13                   │
└──────────────────────────┴────────────────────────────┘
```

**Inline 模式：**

```
┌─ Inline Diff ──────────────────────────────────────┐
│  line 9                                              │
│  - removed line                             ← red/bg │
│  + new line A                              ← green   │
│  + new line B                              ← green   │
│  ┌────────────────────┐                               │
│  │ Accept │ Deny      │  ← IContentWidget             │
│  └────────────────────┘                               │
│  line 10                                              │
└───────────────────────────────────────────────────────┘
```

## 数据流

### Accept Hunk

```
操作: acceptHunk(file, hunk)
  1. SnapshotManager.acceptHunk() → git apply hunk patch 到 snapshot 文件
  2. 如果 snapshot === current file → 删除 snapshot, 从 index.json 移除
  3. 重新读取 snapshot + current 文件内容
  4. SnapshotManager.computeDiff() → 新的 hunk 列表
  5. postMessage({ original, modified, hunks })
```

### Deny Hunk

```
操作: denyHunk(file, hunk)
  1. SnapshotManager.denyHunk() → git apply --reverse hunk patch 到当前文件
  2. 如果 snapshot === current file → 删除 snapshot, 从 index.json 移除
  3. 重新读取 snapshot + current 文件内容
  4. SnapshotManager.computeDiff() → 新的 hunk 列表
  5. postMessage({ original, modified, hunks })
```

### Webview 更新策略

每次操作后完整发送 `original` + `modified` 字符串。Monaco model 通过 `setValue()` 更新，Monaco 自动重新计算 diff 和渲染。Content widgets 在下一次渲染时重新创建。

### Webview ↔ Extension 消息协议

```ts
// Extension → Webview
{ command: 'renderDiff',  original: string, modified: string, hunks: HunkData[], file: string }
{ command: 'diffUpdated', original: string, modified: string, hunks: HunkData[] }
{ command: 'allProcessed' }

// Webview → Extension
{ command: 'ready' }
{ command: 'acceptHunk', hunkId: number }
{ command: 'denyHunk',  hunkId: number }
{ command: 'acceptAll' }
{ command: 'denyAll' }
{ command: 'switchMode', mode: 'side-by-side' | 'inline' }
```

## Webview UI 布局

```
┌──────────────────────────────────────────────────────┐
│  CC Diff: src/foo.ts              [Inline] [Side]    │  ← Toolbar
│  [Accept All]  [Deny All]                            │
├──────────────────────────────────────────────────────┤
│                                                       │
│              Monaco Diff Editor                       │
│            (flex: 1, 占满剩余空间)                     │
│                                                       │
│                                                       │
├──────────────────────────────────────────────────────┤
│  N hunks remaining                                    │  ← 状态栏
└──────────────────────────────────────────────────────┘
```

### Monaco 配置

```js
monaco.editor.createDiffEditor(container, {
  enableSplitViewResizing: true,
  renderSideBySide: true,           // 默认 side-by-side
  readOnly: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  glyphMargin: false,
  lineNumbers: 'on',
  renderIndicators: false,
  originalEditable: false,
})
```

### 样式原则

- 全部使用 `var(--vscode-*)` CSS 变量
- Monaco 主题通过检测 body class（`vscode-dark` / `vscode-high-contrast`）映射到 Monaco 内置主题
- 操作栏按钮：Accept 使用 `--vscode-terminal-ansiGreen`，Deny 使用 `--vscode-terminal-ansiRed`
- 响应式：`ResizeObserver` 监听 container 变化 → `editor.layout()`

## 构建变更

### 新增依赖

```json
"devDependencies": {
  "monaco-editor": "^0.45.0"
}
```

### 构建步骤

```bash
# 1. TypeScript 编译
tsc -p ./

# 2. 复制 webview 资源
node scripts/copy-webview.js
```

### `scripts/copy-webview.js`

```js
// 复制 src/webview/*.html → out/webview/
// 复制 node_modules/monaco-editor/min/vs/ → out/webview/vs/
```

### `package.json` scripts

```json
{
  "compile": "tsc -p ./",
  "copy-webview": "node scripts/copy-webview.js",
  "build": "npm run compile && npm run copy-webview",
  "vscode:prepublish": "npm run build"
}
```

## 文件变更汇总

### 新建

| 文件 | 说明 |
|------|------|
| `src/MonacoDiffProvider.ts` | Monaco WebviewPanel 管理、消息处理、与 SnapshotManager 交互 |
| `src/webview/monaco-diff.html` | Monaco Diff Editor 模板、IContentWidget 逻辑、主题同步、模式切换 |
| `scripts/copy-webview.js` | 复制 Monaco 资源 + HTML 模板到 out/ |

### 删除

| 文件 | 说明 |
|------|------|
| `src/DiffEditorManager.ts` | 原生编辑器 + CodeLens 方案 |
| `src/DiffPanelProvider.ts` | 旧 Webview diff 面板 |
| `src/webview/diff.html` | 旧 diff 模板 |

### 修改

| 文件 | 变更 |
|------|------|
| `src/extension.ts` | `DiffEditorManager` → `MonacoDiffProvider`；移除 CodeLens/InlayHints 注册；调整命令注册 |
| `src/WebviewProvider.ts` | `DiffEditorManager` 引用 → `MonacoDiffProvider` 引用 |
| `package.json` | 移除无用的 CodeLens 相关 activationEvents（如果有）；新增 `copy-webview` 依赖 |
| `tsconfig.json` | 确保 `out/` 输出配置正确 |
| `.vscodeignore` | 确认 `node_modules/monaco-editor/min/**` 在 exclude 之外（仅 `out/webview/vs/` 需要被包含） |

### 保留不变

| 文件 | 说明 |
|------|------|
| `src/SnapshotManager.ts` | 数据层 |
| `src/HooksManager.ts` | Hook 部署 |
| `src/webview/index.html` | 侧边栏模板 |
| `hooks/` | Hook 脚本 |
| `test/` | 测试脚本 |

## 风险与缓解

| 风险 | 可能性 | 影响 | 缓解 |
|------|--------|------|------|
| Monaco 15MB 增加扩展体积 | 确定 | 低 | 主流 VSCode 扩展普遍内置 Monaco（GitLens 25MB+），用户预期内 |
| 首次加载 Webview 慢 (1-2s) | 确定 | 低 | 显示 loading spinner，Monaco AMD 按需加载 |
| Worker 跨域/CSP 问题 | 中 | 高 | 配置 `MonacoEnvironment.getWorkerUrl` 从本地 `vs/` 加载 worker |
| 主题不同步 | 中 | 中 | 监听 webview 宿主样式变化；切换模式时主动同步主题 |
| `.vscodeignore` 配置错误导致 VSIX 体积翻倍 | 中 | 中 | 确保 `node_modules/monaco-editor` 在 ignore 中，仅保留 `out/webview/vs/` |
| Accept/Deny 并发执行导致 diff 状态错乱 | 低 | 高 | 操作队列：每个 hunk 操作必须等上一个完成（extension 端串行处理） |
| ICellWidget 在 Inline 模式位置偏移 | 低 | 中 | 使用 hunk header 中的 `newStart`/`newCount` 精确定位，不依赖 Monaco 的视觉 line number |

## 测试计划

| 层级 | 内容 |
|------|------|
| 编译 | `tsc --noEmit` 类型检查通过 |
| 单元 | `SnapshotManager.acceptHunk` / `denyHunk` 逻辑验证 |
| 手动 | Monaco webview 加载、按钮点击、Side-by-side/Inline 切换、主题跟随 |
| 集成 | 端到端：hook 生成快照 → 侧边栏显示 → 打开 Monaco diff → Accept/Deny hunk → 文件变更正确 |
