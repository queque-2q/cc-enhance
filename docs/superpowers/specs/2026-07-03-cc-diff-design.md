# cc-diff 设计文档

> 仿照 Copilot 对话后 diff 功能的 VSCode 扩展
>
> 日期: 2026-07-03 | 状态: 设计完成

---

## 1. 概述

### 1.1 项目目的

在 VSCode 中使用 Claude Code 时，每次对话结束后自动展示本次修改的所有文件 diff，
提供文件级别和 hunk 级别的 Accept（接受修改）/ Deny（还原修改）操作。

### 1.2 核心流程

```
Claude Code 编辑文件 → 保存快照 → 对话结束 → 计算 diff → 弹出 diff 面板
                                                        ↓
                                     左侧活动栏 Webview: 文件列表 + Accept/Deny
                                                        ↓
                                     点击文件名 → VSCode 原生 Diff Editor
                                     （左: git apply --reverse 结果, 右: 当前文件）
                                                        ↓
                                     手动编辑文件 → 100ms debounce → 刷新左侧内容
```

---

## 2. 架构

### 2.1 系统组件

```
┌─────────────────────────────┐     ┌──────────────────────────┐
│     Claude Code Hooks       │     │    VSCode Extension        │
│                             │     │                          │
│  pre-tool-use.js            │     │  extension.ts            │
│    (PreToolUse hook)        │     │    ├─ WebviewViewProvider  │  ← 左侧活动栏
│    → 保存文件快照            │     │    ├─ FileWatcher         │  ← 监听信号文件
│                             │     │    ├─ DiffManager         │  ← patch 处理
│  session-end.js             │     │    └─ 文件变更监听         │  ← 100ms 实时更新
│    (SessionEnd hook)        │     │                          │
│    → 计算 diff, 保存 patch  │     │                          │
└──────────┬──────────────────┘     └──────────┬───────────────┘
           │                                   │
           └── .claude/cc-diff/ ──────────────┘
              ├── snapshots/<session_id>/   (临时快照)
              ├── patches/<session_id>/     (patch 文件)
              └── session-done.json        (信号文件)
```

### 2.2 数据存储

所有数据存放在目标项目的 `.claude/cc-diff/` 目录下：

```
.claude/cc-diff/
├── snapshots/
│   └── <session_id>/
│       └── src/
│           └── app.ts.snap          # 文件快照（编辑前的原始内容）
├── patches/
│   └── <session_id>/
│       ├── session.json            # 信号文件 + 文件列表
│       └── src/
│           └── app.ts.patch.json   # Hunk 级别 patch
```

---

## 3. Hook 脚本

### 3.1 PreToolUse Hook (`pre-tool-use.js`)

**触发条件**: `PreToolUse` 事件，matcher: `Write|Edit|MultiEdit|NotebookEdit`
**Timeout**: 10s

**stdin 输入**:
```json
{
  "hook_event_name": "PreToolUse",
  "tool_name": "Write",
  "tool_input": { "file_path": "/project/src/app.ts", "content": "..." },
  "session_id": "abc123",
  "cwd": "/project"
}
```

**处理逻辑**:
1. 判断 `tool_name` 是否为 `Write` / `Edit` / `MultiEdit` / `NotebookEdit`
2. 读取 `tool_input.file_path` 的当前内容（文件可能存在也可能不存在，新建文件则快照为空）
3. 快照写入 `.claude/cc-diff/snapshots/<session_id>/<相对路径>.snap`
4. stdout: `{"systemMessage":"snapshot saved"}`，exit 0

### 3.2 SessionEnd Hook (`session-end.js`)

**触发条件**: `SessionEnd` 事件
**Timeout**: 30s

**stdin 输入**:
```json
{
  "hook_event_name": "SessionEnd",
  "session_id": "abc123",
  "cwd": "/project"
}
```

**处理逻辑**:
1. 检查 `.claude/cc-diff/snapshots/<session_id>/` 是否存在，不存在则 exit 0
2. 遍历所有 `.snap` 文件，对每个文件：
   - 读取快照内容（旧内容）
   - 读取当前文件内容（新内容，文件可能已被删除）
   - 使用 `diff` 库（npm: `diff`）计算 unified diff
   - 按 hunk 分割 diff 结果
3. 生成 patch JSON 文件：

```json
{
  "file": "src/app.ts",
  "hunks": [
    {
      "id": 0,
      "header": "@@ -10,6 +10,8 @@",
      "patch": "@@ -10,6 +10,8 @@\n import { foo } from './foo';\n+import { bar } from './bar';\n"
    }
  ]
}
```

   - `id`: hunk 序号（从 0 开始）
   - `header`: `@@` 行文本，用于 UI 展示
   - `patch`: 完整 hunk 文本，可直接 `echo "$patch" | git apply --reverse`

4. 写入信号文件 `session.json`：
```json
{
  "sessionId": "abc123",
  "timestamp": 1691234567890,
  "files": ["src/app.ts", "src/utils.ts"]
}
```

5. 清理 snapshots 目录（保留 patches 用于后续操作）
6. exit 0

---

## 4. VSCode 扩展

### 4.1 入口 (`extension.ts`)

激活时机: `onStartupFinished`

启动时执行：
1. 注册 `WebviewViewProvider` → 左侧活动栏 "CC Diff" 面板
2. 注册 `FileSystemWatcher` → 监听 `.claude/cc-diff/patches/**/session.json`
3. 注册 `workspace.onDidChangeTextDocument` → 监听手动编辑，100ms debounce

### 4.2 WebviewView 面板

**位置**: 左侧活动栏（`viewsContainers.activitybar`），图标使用 VSCode 内置 diff 图标

**内容**:

```
┌──────────────────────────────────────┐
│  CC Diff                   3 files   │
│  Session · 刚刚结束                   │
├──────────────────────────────────────┤
│                                      │
│  🗎  src/app.ts              3 hunks │
│     ─────────────────────────────── │
│                         ✓ Deny ✗    │
│                                      │
│  🗎  src/utils.ts            1 hunk  │
│     ─────────────────────────────── │
│                         ✓ Deny ✗    │
│                                      │
│  🗎  src/lib/foo.ts          2 hunks │
│     ─────────────────────────────── │
│                         ✓ Deny ✗    │
│                                      │
├──────────────────────────────────────┤
│  [Accept All]          [Deny All]    │
│              2/3 files reviewed      │
└──────────────────────────────────────┘
```

**交互行为**:

| 操作 | 行为 |
|------|------|
| 点击文件名 | 打开 VSCode 原生 Diff Editor，左侧 = reverse patch 临时文件，右侧 = 当前文件，`preview: true` |
| 点击 ✓ | Accept 当前文件修改，文件行变灰，从活跃列表移除 |
| 点击 ✗ | Deny 当前文件修改，执行 `git apply --reverse` 还原，文件行变灰 |
| 点击 Accept All | 弹出确认对话框，确认后全部 Accept |
| 点击 Deny All | 弹出确认对话框，确认后全部 Deny |
| 空状态 | 显示 "No changes to review" 居中文案 |

**样式系统**: 全部使用 VSCode CSS 变量，适配所有主题

| 用途 | CSS 变量 |
|------|----------|
| 背景 | `var(--vscode-sideBar-background)` |
| 文字 | `var(--vscode-sideBar-foreground)` |
| 分隔线 | `var(--vscode-sideBar-border)` |
| 行悬停 | `var(--vscode-list-hoverBackground)` |
| Accept | `var(--vscode-terminal-ansiGreen)` |
| Deny | `var(--vscode-terminal-ansiRed)` |
| 次要文字 | `var(--vscode-descriptionForeground)` |
| 字体 | `var(--vscode-font-family)`, 13px / 11px |

**处理后状态**: `opacity: 0.4` + `text-decoration: line-through` + 按钮禁用 + `transition: 0.3s ease`

**底部操作栏**: 左 Accept All / 右 Deny All，中间显示处理进度

### 4.3 DiffManager（diff 处理逻辑）

职责：
- 加载 `session.json` 和所有 `.patch.json` 文件
- 生成左侧临时文件：对当前文件执行 `git apply --reverse <所有未 accept 的 hunks>`，写入临时目录
- 单个 hunks 的 Accept/Deny：跟踪每个文件已 accept 的 hunk 列表
- 文件整体 Accept/Deny：Accept = 所有 hunks 标记 accept 且不做操作；Deny = 所有未 accept hunks 执行 `git apply --reverse`

### 4.4 实时更新（手动编辑时）

```
workspace.onDidChangeTextDocument
  │
  ▼
检查变更文件是否在当前 diff 列表中
  │ 否 → 忽略
  │ 是
  ▼
取消上一次 debounce timer，启动新 100ms timer
  │
  ▼ (100ms 后)
对变更文件重新生成 reverse 临时文件
  │
  ▼
更新 Diff Editor（如果该文件的 diff editor 正在打开）
  │
  ▼
检查每个 hunk 是否能 cleanly apply reverse
  │ 冲突的 hunk → Webview 中对应文件显示 ⚠ 冲突标记
```

### 4.5 Deny 时的冲突处理

```
Deny 整个文件:
  合并所有 hunks → git apply --reverse
  成功 → 文件变灰，标记 done
  冲突 → 按 hunk 逐个尝试:
    hunk N: git apply --reverse <hunk.patch>
    成功 → 标记 applied
    冲突 → 跳过，标记 skipped，UI 提示该 hunk 已被手动修改无法还原
```

---

## 5. 技术栈

| 组件 | 技术 |
|------|------|
| Hook 脚本 | Node.js (CJS, 零依赖，尽可能只用内置模块，diff 计算可用 `diff` 包) |
| VSCode 扩展 | TypeScript, VSCode Extension API |
| Webview UI | HTML + CSS + Vanilla JS (轻量, 无框架) |
| Diff 计算 | `diff` npm 包 (unified diff) |
| 构建 | TypeScript compiler (`tsc`) |

### npm 依赖

**根项目 (hooks 用)**:
- `diff` — 纯 JS dif 计算

**vscode-extension**:
- `@types/vscode` — VSCode API 类型
- `diff` — 与 hooks 共享

---

## 6. 错误处理

| 场景 | 处理 |
|------|------|
| 快照文件不存在 | 跳过，不报错 |
| 编辑后文件被删除 | diff 中旧内容为快照、新内容为空 |
| git apply 冲突 | 降级到 hunk 级别逐个尝试 |
| session.json 不存在 | Webview 显示空状态 |
| 多个 session 堆叠 | 按 timestamp 排序，展示所有未处理 session。全部处理完毕后 24 小时后自动清理该 session 的 patches |
| PreToolUse hook 超时 | 不阻塞编辑（超时后 Claude Code 继续） |

---

## 7. 清理策略

- 多个 session 的 patches 堆叠展示，按 timestamp 排序
- 当某个 session 的全部文件都已处理（Accept 或 Deny），标记为已完成
- 已完成的 session 在 24 小时后自动清理（下次扩展激活时检查并清理）
- 所有 session 都完成时 Webview 显示空状态 "No changes to review"
