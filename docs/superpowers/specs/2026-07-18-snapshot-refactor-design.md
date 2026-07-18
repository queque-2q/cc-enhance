# CC Diff Snapshot 重构设计

**日期:** 2026-07-18
**状态:** 已确认

---

## 1. 目标

将 cc-diff 的核心数据模型从"存储 diff patch"重构为"存储文件快照（snapshot）"，简化数据流，并用自定义 diff 面板替代 VSCode 官方 diff 编辑器，支持可编辑 + 每个 hunk 浮窗 Accept/Deny 按钮。

### 核心变化

| 维度 | 旧方案 | 新方案 |
|------|--------|--------|
| 存储内容 | unified diff patch（hunks） | 文件原始内容（snapshot） |
| session-end 职责 | 计算 diff、生成 patch 文件 | 仅更新 index.json 信号 |
| diff 计算时机 | session-end 时预先计算 | 打开 diff 面板时按需计算 |
| diff 展示 | `vscode.diff` 官方编辑器 | 自定义 Webview Panel |
| Accept | 标记状态（无文件操作） | 正向 apply hunk 到 snapshot |
| Deny | `git apply --reverse` 多层回退 | 反向 apply hunk 到当前文件 |
| 多层 patch 叠加 | 需要 consolidate + layered reverse/re-apply | 不存在（单 snapshot） |

---

## 2. 数据模型

### 2.1 磁盘存储

```
.claude/cc-diff/
├── snapshots/                           ← 持久快照（扁平存储，不按 session 分目录）
│   ├── src-DiffManager.ts.snap          ← 文件的"已批准基线"完整内容
│   └── src-WebviewProvider.ts.snap
├── index.json                           ← 全局清单 v2
└── hooks/
    ├── pre-tool-use.js
    └── session-end.js
```

### 2.2 index.json v2 格式

```json
{
  "version": 2,
  "files": [
    {
      "file": "src/DiffManager.ts",
      "snapshotFile": "src-DiffManager.ts.snap",
      "sessionId": "abc123",
      "timestamp": 1712345678000,
      "status": "pending"
    }
  ]
}
```

- `version: 2` — 与旧格式（v1，存储 patches 数组）不兼容
- `file` — POSIX 相对路径
- `snapshotFile` — safe filename（`/` `\` `:` → `-`）
- `status`: `pending` | `partial` | `accepted`
- **不再存储 hunks/patch 数据**

### 2.3 快照生命周期

```
创建：pre-tool-use 首次编辑文件时 → 保存原始内容 + 注册 index.json
更新：用户 Accept hunk → 正向 apply hunk 到 snapshot（快照前进）
清理：所有 hunk accepted → snapshot == 当前文件 → 删除 .snap + index 条目
```

---

## 3. Hook 脚本变更

### 3.1 pre-tool-use.js

**保持**：编辑前保存快照的逻辑。

**新增**：首次编辑时直接注册到 index.json。

```
收到编辑事件
  → 检查 snapshots/<safeFile>.snap 是否存在
  → 不存在（首次编辑）：
      1. 保存当前文件内容 → snapshots/<safeFile>.snap
      2. 更新 index.json（添加条目，status: "pending"）
  → 已存在：跳过（快照已有）
```

**变化**：从按 session 分目录改为扁平存储。

### 3.2 session-end.js

**大幅简化**：不再计算 diff。

```
收到 Stop 事件
  → 扫描 index.json 中 status="pending" 的文件
  → 对比 snapshot 内容 vs 当前文件内容
  → 无差异 → 从 index 移除（编辑已被用户撤销）
  → 有差异 → 保留，更新 timestamp
  → 原子写回 index.json
  → 结束
```

**删除的职责：** git diff 计算、patch 文件生成、hunk 解析、snapshot 目录清理。

---

## 4. 架构组件

```
Claude Code Hooks                    VSCode 扩展
─────────────────                    ──────────
pre-tool-use.js  ──快照──▶  .claude/cc-diff/  ──监听──▶  extension.ts
session-end.js   ──信号──▶  snapshots/                   ├─ SnapshotManager.ts  (新)
                                index.json               ├─ WebviewProvider.ts  (修改)
                                                         ├─ DiffPanelProvider.ts (新)
                                                         └─ HooksManager.ts     (不变)
```

### 4.1 SnapshotManager.ts（替代 DiffManager.ts）

核心状态管理，不再存储 patches/hunks。

**内存模型：**

```typescript
interface TrackedFile {
  file: string;
  snapshotFile: string;
  sessionId: string;
  timestamp: number;
  status: 'pending' | 'partial' | 'accepted';
}

private files: Map<string, TrackedFile>;  // file path → entry
```

**公开方法：**

| 方法 | 职责 |
|------|------|
| `loadFiles(workspaceRoot)` | 读取 index.json v2，加载到内存 |
| `getAllFiles()` | 返回所有追踪文件路径 |
| `getFileEntry(filePath)` | 返回单个文件的 TrackedFile |
| `getSnapshotPath(filePath)` | 返回 snapshot 文件的绝对路径 |
| `getSnapshotContent(filePath)` | 读取 snapshot 文件内容 |
| `computeDiff(filePath, workspaceRoot)` | `git diff --no-index` snapshot vs 当前文件，返回 parsed hunks |
| `acceptHunk(filePath, hunk, workspaceRoot)` | 正向 apply hunk 到 snapshot；若无剩余 hunk 则清理 |
| `denyHunk(filePath, hunk, workspaceRoot)` | 反向 apply hunk 到工作区文件；若无剩余 hunk 则清理 |
| `acceptAll(filePath)` | 删除 snapshot，从 index 移除 |
| `denyAll(filePath, workspaceRoot)` | 用 snapshot 覆盖当前文件，删除 snapshot，从 index 移除 |

**关键简化（相比旧 DiffManager）：**

- 不再需要 `consolidatePatches` — 单 snapshot，不存在多层叠加
- 不再需要 layered reverse + re-apply — deny 只涉及单个 hunk
- 不再存储 hunks 到磁盘 — diff 按需在内存中计算
- 不再调用 `git apply --reverse` 到工作区文件 — 在 temp 目录操作后写回

### 4.2 WebviewProvider.ts（修改）

保留侧边栏文件列表功能。变更：

- **buildFileList()**: 改用 `SnapshotManager.getFileEntry()` 获取文件状态
- **handleOpenDiff**: 不再调用 `vscode.diff`，改为创建 `DiffPanelProvider` 面板
- **Accept/Deny 逻辑**: 委托给 `SnapshotManager`（不再有 patchId 概念）
- **删除**: `updateDiffTempFile`、`onReverseConflict`、`handleConflict`、`notifyFileChanged` 的 consolidate 逻辑

### 4.3 DiffPanelProvider.ts（新建）

管理自定义 diff 编辑器的 Webview Panel。

**职责：**
- 创建 `vscode.WebviewPanel`（编辑器区域）
- 按需调用 `SnapshotManager.computeDiff()` 获取 hunks
- 渲染统一 diff 视图
- 每个 hunk 浮窗 Accept/Deny 按钮
- 编辑操作：将用户修改写回工作区文件
- Accept/Deny 操作：委托 SnapshotManager，更新视图
- 面板关闭时：重新计算剩余 diff，刷新侧边栏

### 4.4 HooksManager.ts（不变）

Hook 部署和自动更新逻辑保持不变。更新版本标记为 `cc-diff-hooks-v4`。

### 4.5 extension.ts（小幅修改）

- `DiffManager` → `SnapshotManager`
- 文件监听保持不变
- 删除 `onDidChangeTextDocument` 中的 consolidate 逻辑
- 新增 `DiffPanelProvider` 实例化

---

## 5. 自定义 Diff 面板设计

### 5.1 打开流程

```
侧边栏点击文件
  → extension 收到 openDiff 消息
  → 创建 vscode.WebviewPanel（编辑器区域，editor panel 位置）
  → SnapshotManager.computeDiff() → git diff --no-index → 解析 hunks
  → 渲染统一 diff 视图到 webview
```

### 5.2 布局

```
┌─ CC Diff: src/foo.ts ───────────────────────────────────┐
│                                                           │
│  ┌─ Hunk ─────────────────────────────────────────────┐  │
│  │  @@ -10,6 +10,8 @@ import { ...                    │  │
│  │                                                     │  │
│  │     context line                     [Accept][Deny] │  │  ← 浮窗按钮
│  │   - removed line (red, read-only)                  │  │
│  │   + added line (green, editable)                    │  │  ← contenteditable
│  │     context line (editable)                         │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                           │
│  ┌─ Hunk ─────────────────────────────────────────────┐  │
│  │  @@ -25,4 +25,6 @@ function foo()                  │  │
│  │     ...                               [Accept][Deny]│  │
│  └─────────────────────────────────────────────────────┘  │
│                                                           │
│  ┌─ Footer ───────────────────────────────────────────┐  │
│  │              [Accept All]    [Deny All]              │  │
│  └─────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────┘
```

### 5.3 交互行为

| 操作 | 对当前文件 | 对 snapshot | 视觉反馈 |
|------|-----------|-------------|----------|
| 编辑 `+`/context 行 | **立即写入** | 不变 | — |
| **Accept hunk** | 不变 | 正向 apply hunk 写入 | hunk 消失 |
| **Deny hunk** | 反向 apply hunk 写入 | 不变 | hunk 消失 |
| **Accept All** | 不变 | **删除 snapshot 文件** | 面板关闭 |
| **Deny All** | 用 snapshot 内容覆盖 | 不变 | 面板关闭 |

### 5.4 技术方案

- 统一 diff 通过纯 HTML/CSS 渲染，每行一个 `<div>`
- `-` 行（snapshot 旧行）：`var(--vscode-diffEditor-removedTextBackground)` 背景，只读
- `+` 行（当前文件新行）：`var(--vscode-diffEditor-insertedTextBackground)` 背景，`contenteditable="true"`
- context 行：默认背景，`contenteditable="true"`
- 浮窗按钮：绝对定位在 hunk 区域右上角，hover 时显示
- 编辑后的行 → 立即通过 `postMessage` 发回 extension → `fs.writeFileSync` 写回工作区文件
- Deny hunk 时：**不保留用户手动编辑**，直接按 hunk 原始内容反向 apply
- SnapshotManager 的 hunk apply 操作在 temp 目录中完成（使用 `git apply` 或手动行替换），结果安全写回目标文件

---

## 6. 向后兼容

- `index.json` 版本从 v1 → v2，结构完全不同
- **不做数据迁移**。旧 `patches/` 目录和旧 `index.json` 在扩展激活时被忽略
- 如果检测到 v1 格式的 index.json（`version: 1` 或 `patches` 字段存在），扩展跳过加载，输出日志提示
- 用户需要在升级前通过旧版扩展处理完所有 pending patches（Accept/Deny）

---

## 7. 文件改动清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `hooks/pre-tool-use.js` | **重写** | 扁平存储 + 首次编辑注册 index |
| `hooks/session-end.js` | **重写** | 简化为信号通知，无 diff 计算 |
| `src/SnapshotManager.ts` | **新建** | 替代 DiffManager.ts |
| `src/DiffManager.ts` | **删除** | 被 SnapshotManager 替代 |
| `src/DiffPanelProvider.ts` | **新建** | 自定义 diff panel webview |
| `src/WebviewProvider.ts` | **重写** | 接入 SnapshotManager，简化逻辑 |
| `src/extension.ts` | **修改** | 替换 DiffManager → SnapshotManager，新增 DiffPanelProvider |
| `src/HooksManager.ts` | **微改** | 更新版本标记 |
| `src/webview/index.html` | **修改** | 适配新数据结构（去掉 patchId） |
| `src/webview/diff.html` | **新建** | Diff panel 的 webview 模板 |
| `src/webview/diff.js` | **新建** | Diff panel 的客户端脚本（或内联） |
| `test/integration-test.sh` | **修改** | 适配新数据模型 |

---

## 8. 开发顺序

1. **SnapshotManager.ts** — 核心数据层
2. **pre-tool-use.js + session-end.js** — Hook 脚本重写
3. **DiffPanelProvider.ts + diff.html** — 自定义 diff 面板
4. **WebviewProvider.ts + index.html** — 侧边栏适配
5. **extension.ts + HooksManager.ts** — 接线
6. **测试更新** — 集成测试适配
7. **清理** — 删除 DiffManager.ts 和相关死代码
