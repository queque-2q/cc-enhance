# Snapshot 重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 cc-diff 从"存储 diff patch + 官方 diff 编辑器"重构为"存储 snapshot + 自定义可编辑 diff 面板"，简化数据流并提升交互体验。

**Architecture:** SnapshotManager 替代 DiffManager 作为核心数据层（单文件单快照），DiffPanelProvider 提供自定义 Webview Panel 替代 `vscode.diff`，Hook 脚本简化 —— session-end 不再计算 diff。侧边栏 WebviewProvider 保留文件列表功能但大幅简化。

**Tech Stack:** TypeScript strict (ES2022), Node.js CJS (hooks), VSCode API ^1.85, git (diff/apply), vanilla HTML/CSS/JS webview

## Global Constraints

- VSCode engine: ^1.85.0
- Hook 脚本永远不能阻塞编辑器（所有错误 → exit 0）
- Webview CSS 绝不硬编码颜色，必须使用 VSCode CSS 变量
- Hook 脚本路径使用 POSIX 正斜杠
- `index.json` 使用写临时文件→rename 保证原子性
- TypeScript strict mode
- 所有文件路径在 index.json 中使用 POSIX 正斜杠

---

## File Structure

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/SnapshotManager.ts` | 新建 | 核心数据层：snapshot CRUD、diff 计算、hunk accept/deny |
| `src/DiffPanelProvider.ts` | 新建 | 自定义 diff 编辑器的 Webview Panel 管理 |
| `src/webview/diff.html` | 新建 | Diff panel 的完整 webview（HTML + CSS + JS 内联） |
| `hooks/pre-tool-use.js` | 重写 | 扁平存储 snapshot + 首次编辑注册 index |
| `hooks/session-end.js` | 重写 | 简化为信号：验证变更 + 更新 index，不计算 diff |
| `src/WebviewProvider.ts` | 重写 | 侧边栏：接入 SnapshotManager，简化消息处理 |
| `src/webview/index.html` | 修改 | 移除 patchId 概念，适配新 FileSummary |
| `src/extension.ts` | 修改 | SnapshotManager 替代 DiffManager，接入 DiffPanelProvider |
| `src/HooksManager.ts` | 微改 | 版本标记 v3 → v4 |
| `src/DiffManager.ts` | 删除 | 被 SnapshotManager 替代 |
| `test/integration-test.sh` | 修改 | 适配新数据模型 |

---

### Task 1: SnapshotManager.ts — 核心数据层

**Files:**
- Create: `src/SnapshotManager.ts`
- Create: `out/` (compiled output, via `tsc`)

**Interfaces:**
- Produces: `HunkData`, `TrackedFile`, `SnapshotManager` class — consumed by Tasks 3, 4, 5

- [ ] **Step 1: Create the file with all imports, types, and class skeleton**

```typescript
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

// ======================================================================
// Types
// ======================================================================

export interface HunkData {
  id: number;
  header: string;
  patch: string;
}

export type FileStatus = 'pending' | 'partial' | 'accepted';

export interface TrackedFile {
  file: string;
  snapshotFile: string;
  sessionId: string;
  timestamp: number;
  status: FileStatus;
}

interface IndexEntryV2 {
  file: string;
  snapshotFile: string;
  sessionId: string;
  timestamp: number;
  status: string;
}

interface IndexDataV2 {
  version: number;
  files: IndexEntryV2[];
}

// ======================================================================
// SnapshotManager
// ======================================================================

export class SnapshotManager {
  private files: Map<string, TrackedFile> = new Map();
  private workspaceRoot: string = '';
  private logger: (msg: string) => void = () => {};

  setLogger(logger: (msg: string) => void): void {
    this.logger = logger;
  }

  setWorkspaceRoot(root: string): void {
    this.workspaceRoot = root;
  }
}
```

- [ ] **Step 2: Implement `setLogger` and `setWorkspaceRoot` have already been added. Verify skeleton compiles**

Run: `cd f:/node/cc-diff && npx tsc --noEmit`
Expected: No errors (or just "cannot find module" for imports — that's fine, we're adding more)

- [ ] **Step 3: Implement `loadFiles` — read index.json v2, populate memory map**

Add these methods after the skeleton:

```typescript
  // ------------------------------------------------------------------
  // Loading
  // ------------------------------------------------------------------

  /**
   * Load tracked files from index.json v2.
   * Skips v1 format (which has `patches` array).
   * Idempotent — clears and reloads each call.
   */
  loadFiles(workspaceRoot: string): void {
    const ccDiffDir = path.join(workspaceRoot, '.claude', 'cc-diff');
    const indexPath = path.join(ccDiffDir, 'index.json');

    if (!fs.existsSync(indexPath)) {
      this.files.clear();
      return;
    }

    const index = this.readIndexFromDisk(indexPath);
    if (!index || index.version !== 2) {
      // v1 format or corrupt — skip
      if (index && (index as any).patches) {
        this.logger('loadFiles: v1 index.json detected — ignoring (manual migration required)');
      }
      this.files.clear();
      return;
    }

    this.files.clear();
    for (const entry of index.files) {
      this.files.set(entry.file, {
        file: entry.file,
        snapshotFile: entry.snapshotFile,
        sessionId: entry.sessionId,
        timestamp: entry.timestamp,
        status: entry.status as FileStatus,
      });
    }

    if (this.files.size > 0) {
      this.logger(`loadFiles: ${this.files.size} tracked file(s)`);
    }
  }
```

- [ ] **Step 4: Verify compile**

Run: `cd f:/node/cc-diff && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 5: Implement `readIndexFromDisk` and `writeIndexToDisk` (private)**

```typescript
  // ------------------------------------------------------------------
  // Index I/O (private)
  // ------------------------------------------------------------------

  private readIndexFromDisk(indexPath: string): IndexDataV2 | null {
    if (!fs.existsSync(indexPath)) return null;
    try {
      const raw = fs.readFileSync(indexPath, 'utf8');
      const data = JSON.parse(raw);
      if (!Array.isArray(data.files)) return null;
      return data;
    } catch {
      this.logger('readIndexFromDisk: WARN — cannot parse, returning null');
      return null;
    }
  }

  private writeIndexToDisk(indexPath: string, data: IndexDataV2): void {
    const tmpPath = indexPath + '.tmp-' + Date.now();
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmpPath, indexPath);
    } catch (e: any) {
      this.logger(`writeIndexToDisk: ERROR — ${e.message}`);
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  }
```

- [ ] **Step 6: Verify compile**

Run: `cd f:/node/cc-diff && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 7: Implement accessor methods**

```typescript
  // ------------------------------------------------------------------
  // Accessors
  // ------------------------------------------------------------------

  getAllFiles(): string[] {
    return [...this.files.keys()];
  }

  getFileEntry(filePath: string): TrackedFile | undefined {
    const posixPath = filePath.replace(/\\/g, '/');
    return this.files.get(posixPath);
  }

  getSnapshotPath(filePath: string): string {
    const entry = this.getFileEntry(filePath);
    if (!entry) return '';
    const snapshotsDir = path.join(this.workspaceRoot, '.claude', 'cc-diff', 'snapshots');
    return path.join(snapshotsDir, entry.snapshotFile);
  }

  getSnapshotContent(filePath: string): string | null {
    const snapPath = this.getSnapshotPath(filePath);
    if (!snapPath || !fs.existsSync(snapPath)) return null;
    try {
      return fs.readFileSync(snapPath, 'utf8');
    } catch {
      return null;
    }
  }

  isAllProcessed(): boolean {
    return this.files.size === 0;
  }
```

- [ ] **Step 8: Verify compile**

Run: `cd f:/node/cc-diff && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 9: Implement diff computation — `gitDiff` (private) and `computeDiff` (public)**

```typescript
  // ------------------------------------------------------------------
  // Diff computation
  // ------------------------------------------------------------------

  /**
   * Compute unified diff between snapshot and current workspace file.
   * Returns parsed hunks ready for the diff panel.
   */
  computeDiff(filePath: string, workspaceRoot: string): HunkData[] {
    const snapshotContent = this.getSnapshotContent(filePath);
    if (snapshotContent === null) return [];

    const absPath = path.resolve(workspaceRoot, filePath);
    let currentContent = '';
    try {
      currentContent = fs.readFileSync(absPath, 'utf8');
    } catch {
      // File doesn't exist — treat as empty
    }

    if (snapshotContent === currentContent) return [];

    const patchText = this.gitDiff(snapshotContent, currentContent, filePath);
    if (!patchText) return [];

    return this.parseHunks(patchText);
  }

  /**
   * Generate unified diff between two content strings using `git diff --no-index`.
   */
  private gitDiff(oldContent: string, newContent: string, relativeFile: string): string {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-diff-'));
    try {
      const oldTmp = path.join(tmpDir, 'a', relativeFile);
      const newTmp = path.join(tmpDir, 'b', relativeFile);

      fs.mkdirSync(path.dirname(oldTmp), { recursive: true });
      fs.mkdirSync(path.dirname(newTmp), { recursive: true });
      fs.writeFileSync(oldTmp, oldContent, 'utf8');
      fs.writeFileSync(newTmp, newContent, 'utf8');

      const posixPath = relativeFile.replace(/\\/g, '/');
      let stdout: string;
      try {
        stdout = execSync(
          `git diff --no-index --no-color -U3 "a/${posixPath}" "b/${posixPath}"`,
          { encoding: 'utf8', stdio: 'pipe', timeout: 10000, cwd: tmpDir, windowsHide: true }
        );
      } catch (e: any) {
        if (e.status === 1 && e.stdout) {
          stdout = typeof e.stdout === 'string' ? e.stdout : e.stdout.toString();
        } else {
          this.logger(`[gitDiff] FAILED for "${relativeFile}": status=${e.status}`);
          return '';
        }
      }

      return stdout || '';
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }

  /**
   * Parse a unified diff string into individual hunks.
   */
  private parseHunks(patchText: string): HunkData[] {
    const hunks: HunkData[] = [];
    const lines = patchText.split('\n');
    let currentHunk: HunkData | null = null;
    let hunkId = 0;
    let inHeader = true;

    for (const line of lines) {
      if (inHeader && line.startsWith('@@')) {
        inHeader = false;
      }
      if (inHeader) continue;

      if (line.startsWith('@@')) {
        if (currentHunk) {
          hunks.push(currentHunk);
        }
        currentHunk = {
          id: hunkId++,
          header: line,
          patch: line + '\n',
        };
      } else if (currentHunk) {
        currentHunk.patch += line + '\n';
      }
    }

    if (currentHunk) {
      hunks.push(currentHunk);
    }

    return hunks;
  }
```

- [ ] **Step 10: Verify compile**

Run: `cd f:/node/cc-diff && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 11: Implement `applyHunkToContent` (private) — the core hunk application engine**

```typescript
  // ------------------------------------------------------------------
  // Hunk application (private)
  // ------------------------------------------------------------------

  /**
   * Apply or reverse-apply a single hunk to content in a temp directory.
   * Uses `git apply` for reliability with edge cases (line endings, context matching).
   */
  private applyHunkToContent(
    content: string,
    relativeFile: string,
    hunkPatch: string,
    reverse: boolean
  ): { success: boolean; content?: string; error?: string } {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-diff-'));
    try {
      const fileDir = path.join(tmpDir, path.dirname(relativeFile));
      if (fileDir !== tmpDir) {
        fs.mkdirSync(fileDir, { recursive: true });
      }
      const tmpFile = path.join(tmpDir, relativeFile);
      fs.writeFileSync(tmpFile, content, 'utf8');

      const posixPath = relativeFile.replace(/\\/g, '/');
      const fullPatch = `--- a/${posixPath}\n+++ b/${posixPath}\n` + hunkPatch;
      const patchFile = path.join(tmpDir, 'hunk.patch');
      fs.writeFileSync(patchFile, fullPatch, 'utf8');

      const cmd = reverse
        ? `git apply --reverse "${patchFile}"`
        : `git apply "${patchFile}"`;
      execSync(cmd, {
        cwd: tmpDir,
        stdio: 'pipe',
        timeout: 5000,
        windowsHide: true,
      });

      const resultContent = fs.readFileSync(tmpFile, 'utf8');
      return { success: true, content: resultContent };
    } catch (e: any) {
      const stderr = e.stderr?.toString() || e.message || 'Unknown git error';
      return { success: false, error: stderr };
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }
```

- [ ] **Step 12: Verify compile**

Run: `cd f:/node/cc-diff && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 13: Implement hunk-level operations (public)**

```typescript
  // ------------------------------------------------------------------
  // Hunk-level operations
  // ------------------------------------------------------------------

  /**
   * Accept a hunk: forward-apply the hunk patch to the snapshot.
   * If no remaining diffs exist after this, clean up the snapshot.
   */
  acceptHunk(filePath: string, hunk: HunkData, workspaceRoot: string): { success: boolean; error?: string } {
    const entry = this.getFileEntry(filePath);
    if (!entry) return { success: false, error: 'File not tracked' };

    const snapPath = this.getSnapshotPath(filePath);
    const currentContent = this.getSnapshotContent(filePath);
    if (currentContent === null) return { success: false, error: 'Snapshot not found' };

    // Forward-apply hunk to snapshot content
    const result = this.applyHunkToContent(currentContent, filePath, hunk.patch, /* reverse */ false);
    if (!result.success) {
      this.logger(`[acceptHunk] FAILED for "${filePath}" hunk ${hunk.id}: ${result.error}`);
      return { success: false, error: result.error };
    }

    // Write updated snapshot
    fs.writeFileSync(snapPath, result.content!, 'utf8');

    // Check if all changes are now accepted (snapshot matches current file)
    const absPath = path.resolve(workspaceRoot, filePath);
    let workspaceContent = '';
    try { workspaceContent = fs.readFileSync(absPath, 'utf8'); } catch {}

    if (result.content === workspaceContent) {
      // All changes accepted — clean up
      this.removeFromIndex(filePath);
      this.files.delete(entry.file);
      try { fs.unlinkSync(snapPath); } catch {}
      this.logger(`[acceptHunk] "${filePath}" — all changes accepted, cleaned up`);
    }

    return { success: true };
  }

  /**
   * Deny a hunk: reverse-apply the hunk patch to the current workspace file.
   * Does NOT preserve user manual edits — applies the original hunk in reverse directly.
   * If no remaining diffs exist after this, clean up the snapshot.
   */
  denyHunk(filePath: string, hunk: HunkData, workspaceRoot: string): { success: boolean; error?: string } {
    const entry = this.getFileEntry(filePath);
    if (!entry) return { success: false, error: 'File not tracked' };

    const absPath = path.resolve(workspaceRoot, filePath);
    if (!fs.existsSync(absPath)) return { success: false, error: 'File not found' };

    let currentContent: string;
    try {
      currentContent = fs.readFileSync(absPath, 'utf8');
    } catch {
      return { success: false, error: 'Cannot read file' };
    }

    // Reverse-apply hunk to current file content
    const result = this.applyHunkToContent(currentContent, filePath, hunk.patch, /* reverse */ true);
    if (!result.success) {
      this.logger(`[denyHunk] FAILED for "${filePath}" hunk ${hunk.id}: ${result.error}`);
      return { success: false, error: result.error };
    }

    // Write reverted content back to workspace file
    fs.writeFileSync(absPath, result.content!, 'utf8');

    // Check if all changes are now denied (snapshot matches current file)
    const snapshotContent = this.getSnapshotContent(filePath);
    if (snapshotContent === result.content) {
      // All changes reverted — clean up
      this.removeFromIndex(filePath);
      this.files.delete(entry.file);
      const snapPath = this.getSnapshotPath(filePath);
      try { fs.unlinkSync(snapPath); } catch {}
      this.logger(`[denyHunk] "${filePath}" — all changes reverted, cleaned up`);
    }

    return { success: true };
  }
```

- [ ] **Step 14: Verify compile**

Run: `cd f:/node/cc-diff && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 15: Implement bulk operations (public)**

```typescript
  // ------------------------------------------------------------------
  // Bulk operations
  // ------------------------------------------------------------------

  /**
   * Accept all changes for a file: delete the snapshot, keep current file.
   */
  acceptAll(filePath: string): void {
    const entry = this.getFileEntry(filePath);
    if (!entry) return;

    const snapPath = this.getSnapshotPath(filePath);
    try { if (fs.existsSync(snapPath)) fs.unlinkSync(snapPath); } catch {}

    this.removeFromIndex(filePath);
    this.files.delete(entry.file);
    this.logger(`[acceptAll] "${filePath}" — snapshot deleted`);
  }

  /**
   * Deny all changes for a file: overwrite current file with snapshot content.
   */
  denyAll(filePath: string, workspaceRoot: string): { success: boolean; error?: string } {
    const entry = this.getFileEntry(filePath);
    if (!entry) return { success: false, error: 'File not tracked' };

    const snapshotContent = this.getSnapshotContent(filePath);
    if (snapshotContent === null) return { success: false, error: 'Snapshot not found' };

    const absPath = path.resolve(workspaceRoot, filePath);
    try {
      fs.writeFileSync(absPath, snapshotContent, 'utf8');
    } catch (e: any) {
      return { success: false, error: e.message };
    }

    // Clean up
    const snapPath = this.getSnapshotPath(filePath);
    try { if (fs.existsSync(snapPath)) fs.unlinkSync(snapPath); } catch {}

    this.removeFromIndex(filePath);
    this.files.delete(entry.file);
    this.logger(`[denyAll] "${filePath}" — reverted to snapshot, cleaned up`);

    return { success: true };
  }
```

- [ ] **Step 16: Verify compile**

Run: `cd f:/node/cc-diff && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 17: Implement `removeFromIndex` (private) — thread-safe index entry removal**

```typescript
  // ------------------------------------------------------------------
  // Index maintenance (private)
  // ------------------------------------------------------------------

  /**
   * Remove a file entry from index.json.
   * Thread-safe: read-modify-write with re-read verification.
   */
  private removeFromIndex(filePath: string): void {
    if (!this.workspaceRoot) return;

    const ccDiffDir = path.join(this.workspaceRoot, '.claude', 'cc-diff');
    const indexPath = path.join(ccDiffDir, 'index.json');

    if (!fs.existsSync(indexPath)) return;

    // 1. Read current state
    const current = this.readIndexFromDisk(indexPath);
    if (!current || !Array.isArray(current.files)) return;

    const before = current.files.length;
    current.files = current.files.filter(f => f.file !== filePath);

    if (current.files.length === before) return; // Not found

    if (current.files.length === 0) {
      // Verify before deleting index.json
      const verify = this.readIndexFromDisk(indexPath);
      if (verify && verify.files.length === 0) {
        try { fs.unlinkSync(indexPath); } catch (e: any) {
          this.logger(`[removeFromIndex] WARN — failed to delete index.json: ${e.message}`);
        }
      } else if (verify && verify.files.length > 0) {
        // Concurrent hook added entries
        this.writeIndexToDisk(indexPath, verify);
      }
      return;
    }

    // 2. Atomic write
    this.writeIndexToDisk(indexPath, current);

    // 3. Re-read and merge concurrent entries
    const verifyRead = this.readIndexFromDisk(indexPath);
    if (verifyRead) {
      const unknownEntries = verifyRead.files.filter(
        f => !current.files.some(cf => cf.file === f.file)
      );
      if (unknownEntries.length > 0) {
        this.logger(`[removeFromIndex] detected ${unknownEntries.length} concurrent entry(ies), merging...`);
        current.files.push(...unknownEntries);
        this.writeIndexToDisk(indexPath, current);
      }
    }
  }
```

- [ ] **Step 18: Verify compile**

Run: `cd f:/node/cc-diff && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 19: Full compile and check output**

Run: `cd f:/node/cc-diff && npx tsc -p ./`
Expected: `src/SnapshotManager.ts` compiles to `out/SnapshotManager.js` without errors.

- [ ] **Step 20: Commit**

```bash
cd f:/node/cc-diff && git add src/SnapshotManager.ts out/SnapshotManager.js && git commit -m "feat: add SnapshotManager — core snapshot data layer"
```

---

### Task 2: Rewrite pre-tool-use.js — Flat snapshot storage

**Files:**
- Modify: `hooks/pre-tool-use.js` (full rewrite)

**Interfaces:**
- Produces: snapshot files at `.claude/cc-diff/snapshots/<safeFile>.snap` + index.json v2 entries
- Consumed by: session-end.js (Task 3), SnapshotManager.loadFiles (Task 1)

- [ ] **Step 1: Write the new pre-tool-use.js**

```javascript
#!/usr/bin/env node
/**
 * cc-diff PreToolUse Hook (v4)
 *
 * Saves a snapshot of file content before Claude Code edits it.
 * Uses flat storage: .claude/cc-diff/snapshots/<safeFile>.snap
 * Registers to index.json v2 on first edit.
 *
 * stdin:  { hook_event_name, tool_name, tool_input, session_id, cwd }
 * stdout: { systemMessage: "..." }
 */

'use strict';

const fs = require('fs');
const path = require('path');

/** Normalize any path to POSIX (forward slashes) for cross-platform storage. */
const toPosix = (p) => p.replace(/\\/g, '/');

/**
 * Script is at <workspace>/.claude/cc-diff/hooks/pre-tool-use.js
 * ccDiffRoot = <workspace>/.claude/cc-diff
 * workspaceRoot = <workspace>
 */
function getDirs() {
  const ccDiffRoot = path.dirname(__dirname);
  const workspaceRoot = path.dirname(path.dirname(ccDiffRoot));
  return { ccDiffRoot, workspaceRoot };
}

/** Replace path separators and colons with dashes for safe filenames. */
function toSafeFileName(relativeFile) {
  return relativeFile.replace(/[/\\:]/g, '-');
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch (e) { reject(e); }
    });
    process.stdin.on('error', reject);
  });
}

function getFilePath(toolInput) {
  return toolInput.file_path || toolInput.notebook_path || null;
}

// ── Index I/O ──────────────────────────────────────────────────────

function readIndex(indexPath) {
  if (!fs.existsSync(indexPath)) {
    return { version: 2, files: [] };
  }
  try {
    const raw = fs.readFileSync(indexPath, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.files)) {
      return { version: 2, files: [] };
    }
    return data;
  } catch (e) {
    return { version: 2, files: [] };
  }
}

function writeIndex(indexPath, indexData) {
  const tmpPath = indexPath + '.tmp-' + Date.now();
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(indexData, null, 2), 'utf8');
    fs.renameSync(tmpPath, indexPath);
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

// ── Main ───────────────────────────────────────────────────────────

async function main() {
  try {
    const event = await readStdin();
    const { tool_input, session_id } = event;

    const filePath = getFilePath(tool_input);
    if (!filePath) {
      console.log(JSON.stringify({ systemMessage: 'no file path, skipping' }));
      process.exit(0);
    }

    const { ccDiffRoot, workspaceRoot } = getDirs();

    // Resolve absolute path
    const absPath = path.resolve(workspaceRoot, filePath);

    // Compute POSIX relative path for index key
    const posixRoot = toPosix(workspaceRoot);
    const posixAbsPath = toPosix(absPath);
    let relativePath = path.posix.relative(posixRoot, posixAbsPath);
    if (relativePath.startsWith('..')) {
      relativePath = path.posix.basename(posixAbsPath);
    }

    const safeFile = toSafeFileName(relativePath);
    const snapshotsDir = path.join(ccDiffRoot, 'snapshots');
    const snapPath = path.join(snapshotsDir, safeFile + '.snap');

    // Check if snapshot already exists (this file is already tracked)
    if (fs.existsSync(snapPath)) {
      console.log(JSON.stringify({ systemMessage: 'snapshot already exists, skipping' }));
      process.exit(0);
    }

    // Ensure directory exists
    fs.mkdirSync(snapshotsDir, { recursive: true });

    // Read current file content (empty string if file doesn't exist — new file)
    let content = '';
    try {
      content = fs.readFileSync(absPath, 'utf8');
    } catch (e) {
      // File doesn't exist — this is a new file being created
    }

    // Write snapshot
    fs.writeFileSync(snapPath, content, 'utf8');

    // Register in index.json v2
    const indexPath = path.join(ccDiffRoot, 'index.json');
    const index = readIndex(indexPath);

    // Check if already registered (same file path)
    const existing = index.files.find(f => f.file === relativePath);
    if (!existing) {
      index.files.push({
        file: relativePath,
        snapshotFile: safeFile + '.snap',
        sessionId: session_id,
        timestamp: Date.now(),
        status: 'pending',
      });
      writeIndex(indexPath, index);
    }

    console.log(JSON.stringify({ systemMessage: 'snapshot saved' }));
  } catch (err) {
    console.error('[cc-diff pre-tool-use]', err.message);
  }
  process.exit(0);
}

main();
```

- [ ] **Step 2: Test hook script manually**

```bash
cd /tmp && rm -rf cc-diff-hook-test && mkdir cc-diff-hook-test && cd cc-diff-hook-test && \
mkdir -p .claude/cc-diff/hooks && \
cp f:/node/cc-diff/hooks/pre-tool-use.js .claude/cc-diff/hooks/ && \
echo "line 1
line 2
line 3" > hello.txt && \
echo '{"hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"hello.txt"},"session_id":"test-s1","cwd":"'$(pwd)'"}' | node .claude/cc-diff/hooks/pre-tool-use.js && \
echo "Exit code: $?" && \
echo "Snapshot exists:" && test -f .claude/cc-diff/snapshots/hello.txt.snap && echo "YES" || echo "NO" && \
echo "Snapshot content:" && cat .claude/cc-diff/snapshots/hello.txt.snap && \
echo "" && echo "index.json:" && cat .claude/cc-diff/index.json
```

Expected: Exit 0, snapshot file created with original content, index.json v2 entry with status "pending".

- [ ] **Step 3: Test idempotency — run pre-tool-use again on same file**

```bash
cd /tmp/cc-diff-hook-test && \
echo "line 1
line 2 modified
line 3" > hello.txt && \
echo '{"hook_event_name":"PreToolUse","tool_name":"Edit","tool_input":{"file_path":"hello.txt"},"session_id":"test-s2","cwd":"'$(pwd)'"}' | node .claude/cc-diff/hooks/pre-tool-use.js && \
echo "Exit code: $?" && \
echo "Snapshot unchanged:" && cat .claude/cc-diff/snapshots/hello.txt.snap
```

Expected: Exit 0, "snapshot already exists, skipping", snapshot content unchanged (original, not modified).

- [ ] **Step 4: Commit**

```bash
cd f:/node/cc-diff && git add hooks/pre-tool-use.js && git commit -m "feat: rewrite pre-tool-use.js — flat snapshot storage + index.json v2 registration"
```

---

### Task 3: Rewrite session-end.js — Signal-only notification

**Files:**
- Modify: `hooks/session-end.js` (full rewrite)

**Interfaces:**
- Consumes: snapshot files + index.json v2 (from Task 2)
- Produces: updated index.json (removes stale entries, updates timestamps)
- Consumed by: extension.ts FileSystemWatcher → SnapshotManager.loadFiles (Task 1)

- [ ] **Step 1: Write the new session-end.js**

```javascript
#!/usr/bin/env node
/**
 * cc-diff Stop Hook (v4)
 *
 * Simplified: scans tracked files in index.json, verifies each file
 * still has changes vs its snapshot, removes entries where the file
 * was reverted (no diff). No longer computes or stores diffs.
 *
 * stdin:  { hook_event_name, session_id, cwd }
 * stdout: (none — writes index.json)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Helpers ────────────────────────────────────────────────────────

const toPosix = (p) => p.replace(/\\/g, '/');

/**
 * Script is at <workspace>/.claude/cc-diff/hooks/session-end.js
 */
function getCcDiffRoot() {
  return path.dirname(__dirname);
}

// ── Debug log ──────────────────────────────────────────────────────

const debugLogDir = path.join(os.tmpdir(), 'cc-diff-debug');
try { fs.mkdirSync(debugLogDir, { recursive: true }); } catch {}
function debugLog(msg) {
  try {
    fs.appendFileSync(
      path.join(debugLogDir, 'session-end.log'),
      `[${new Date().toISOString()}] ${msg}\n`, 'utf8'
    );
  } catch {}
}

// ── Index I/O ──────────────────────────────────────────────────────

function readIndex(indexPath) {
  if (!fs.existsSync(indexPath)) {
    return { version: 2, files: [] };
  }
  try {
    const raw = fs.readFileSync(indexPath, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.files)) {
      return { version: 2, files: [] };
    }
    return data;
  } catch (e) {
    debugLog(`readIndex: WARN — ${e.message}`);
    return { version: 2, files: [] };
  }
}

function writeIndex(indexPath, indexData) {
  const tmpPath = indexPath + '.tmp-' + Date.now();
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(indexData, null, 2), 'utf8');
    fs.renameSync(tmpPath, indexPath);
  } catch (e) {
    debugLog(`writeIndex: ERROR — ${e.message}`);
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

// ── Main ───────────────────────────────────────────────────────────

async function main() {
  try {
    // --- Read stdin ---
    const stdinRaw = await new Promise((resolve) => {
      let data = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => { data += chunk; });
      process.stdin.on('end', () => resolve(data));
      process.stdin.on('error', () => resolve(data));
    });

    let session_id = 'unknown';
    try {
      const event = JSON.parse(stdinRaw);
      session_id = event.session_id || 'unknown';
    } catch {}

    const ccDiffRoot = getCcDiffRoot();
    const workspaceRoot = path.dirname(path.dirname(ccDiffRoot));
    debugLog(`session_id=${session_id} workspaceRoot="${workspaceRoot}"`);

    // --- Read index.json ---
    const indexPath = path.join(ccDiffRoot, 'index.json');
    const index = readIndex(indexPath);

    if (index.version !== 2 || index.files.length === 0) {
      debugLog('EXIT: no v2 tracked files');
      process.exit(0);
    }

    const snapshotsDir = path.join(ccDiffRoot, 'snapshots');
    const now = Date.now();
    let removedCount = 0;
    let updatedCount = 0;

    // --- Verify each tracked file ---
    const kept = [];

    for (const entry of index.files) {
      const snapPath = path.join(snapshotsDir, entry.snapshotFile);

      // Read snapshot
      let snapshotContent = '';
      try {
        snapshotContent = fs.readFileSync(snapPath, 'utf8');
      } catch (e) {
        debugLog(`  REMOVE: "${entry.file}" — snapshot file missing`);
        removedCount++;
        continue;
      }

      // Read current workspace file
      const absPath = path.resolve(workspaceRoot, entry.file);
      let currentContent = '';
      try {
        currentContent = fs.readFileSync(absPath, 'utf8');
      } catch (e) {
        // File deleted — still a change (from exists to not exists)
        // Keep the entry so user can review
      }

      // If content is identical, the edit was reverted — remove entry
      if (snapshotContent === currentContent) {
        debugLog(`  REMOVE: "${entry.file}" — no changes (reverted)`);
        try { fs.unlinkSync(snapPath); } catch {}
        removedCount++;
        continue;
      }

      // Has changes — keep entry, update timestamp
      entry.timestamp = now;
      entry.status = entry.status || 'pending';
      kept.push(entry);
      updatedCount++;
      debugLog(`  KEEP: "${entry.file}" — changes detected`);
    }

    // --- Write updated index ---
    if (removedCount > 0 || updatedCount > 0) {
      const newIndex = { version: 2, files: kept };
      writeIndex(indexPath, newIndex);
      debugLog(`DONE: ${removedCount} removed, ${updatedCount} kept — total: ${kept.length}`);
    } else {
      debugLog('DONE: no changes');
    }

  } catch (err) {
    debugLog(`FATAL: ${err.message}\n${err.stack || ''}`);
    console.error('[cc-diff session-end]', err.message);
  }
  process.exit(0);
}

main();
```

- [ ] **Step 2: Test session-end — verify it removes reverted files**

```bash
cd /tmp/cc-diff-hook-test && \
cp f:/node/cc-diff/hooks/session-end.js .claude/cc-diff/hooks/ && \
echo '{"hook_event_name":"Stop","session_id":"test-s1","cwd":"'$(pwd)'"}' | node .claude/cc-diff/hooks/session-end.js && \
echo "Exit code: $?" && \
echo "After session-end (file unchanged — should remove snapshot):" && \
cat .claude/cc-diff/index.json 2>/dev/null || echo "(index.json removed)"
```

Expected: Exit 0, snapshot deleted, entry removed from index.json.

- [ ] **Step 3: Test session-end with actual changes**

```bash
cd /tmp/cc-diff-hook-test && \
echo "line 1
line 2
line 3" > hello.txt && \
echo '{"hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"hello.txt"},"session_id":"test-s2","cwd":"'$(pwd)'"}' | node .claude/cc-diff/hooks/pre-tool-use.js && \
echo "line 1
line 2 MODIFIED
line 3
line 4 NEW" > hello.txt && \
echo '{"hook_event_name":"Stop","session_id":"test-s2","cwd":"'$(pwd)'"}' | node .claude/cc-diff/hooks/session-end.js && \
echo "Exit code: $?" && \
echo "index.json with changes:" && cat .claude/cc-diff/index.json
```

Expected: Exit 0, index.json has 1 entry with "pending" status, snapshot preserved.

- [ ] **Step 4: Commit**

```bash
cd f:/node/cc-diff && git add hooks/session-end.js && git commit -m "feat: rewrite session-end.js — signal-only, no diff computation"
```

---

### Task 4: Custom diff panel webview — diff.html

**Files:**
- Create: `src/webview/diff.html`

**Interfaces:**
- Consumes: `{ command: 'renderDiff', file, hunks, currentContent }` from extension
- Produces: `{ command: 'acceptHunk' | 'denyHunk' | 'acceptAll' | 'denyAll' | 'editLine', ... }` to extension
- Consumed by: DiffPanelProvider (Task 5)

- [ ] **Step 1: Create diff.html with complete HTML + CSS + JS**

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
      --removed-bg: var(--vscode-diffEditor-removedTextBackground, rgba(255,0,0,0.15));
      --removed-fg: var(--vscode-diffEditor-removedLineText, #f48771);
      --inserted-bg: var(--vscode-diffEditor-insertedTextBackground, rgba(0,255,0,0.1));
      --inserted-fg: var(--vscode-diffEditor-insertedLineText, #89d185);
      --accent: var(--vscode-textLink-foreground, #3794ff);
      --green: var(--vscode-terminal-ansiGreen, #23a952);
      --red: var(--vscode-terminal-ansiRed, #e54b4b);
      --font: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
      --mono: var(--vscode-editor-font-family, 'Cascadia Code', 'Consolas', 'Courier New', monospace);
      --radius: 4px;
    }
    body {
      font-family: var(--font);
      font-size: 13px;
      color: var(--fg);
      background: var(--bg);
      line-height: 1.6;
      padding: 12px 0;
      -webkit-font-smoothing: antialiased;
    }
    .header-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 0 16px 8px 16px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 12px;
    }
    .header-filename {
      font-family: var(--mono);
      font-size: 12px;
      font-weight: 600;
      color: var(--fg);
      flex: 1;
    }
    .hunk {
      position: relative;
      margin: 0 8px 8px 8px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
    }
    .hunk-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 10px;
      background: color-mix(in srgb, var(--border) 30%, var(--bg));
      font-family: var(--mono);
      font-size: 11px;
      color: var(--muted);
    }
    .hunk-actions {
      display: flex;
      gap: 4px;
      opacity: 0;
      transition: opacity 0.15s ease;
    }
    .hunk:hover .hunk-actions { opacity: 1; }
    .hunk-actions:focus-within { opacity: 1; }
    .btn-mini {
      font-family: var(--font);
      font-size: 10px;
      font-weight: 600;
      padding: 0px 7px;
      height: 18px;
      line-height: 16px;
      border: 1px solid;
      border-radius: 3px;
      cursor: pointer;
      background: transparent;
      transition: 0.12s ease;
    }
    .btn-accept { border-color: var(--green); color: var(--green); }
    .btn-accept:hover { background: var(--green); color: var(--btn-text, #fff); }
    .btn-deny { border-color: var(--red); color: var(--red); }
    .btn-deny:hover { background: var(--red); color: var(--btn-text, #fff); }
    .diff-line {
      display: flex;
      font-family: var(--mono);
      font-size: 12px;
      line-height: 1.55;
      padding: 0 10px;
      min-height: 20px;
      white-space: pre;
      border: 1px solid transparent;
    }
    .diff-line:focus { outline: none; border-color: var(--accent); }
    .line-removed {
      background: var(--removed-bg);
      color: var(--removed-fg);
    }
    .line-added {
      background: var(--inserted-bg);
      color: var(--inserted-fg);
    }
    .line-context {
      color: var(--fg);
    }
    .line-prefix {
      width: 16px;
      flex-shrink: 0;
      user-select: none;
      text-align: center;
      margin-right: 6px;
      opacity: 0.6;
    }
    .footer-bar {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 8px 16px;
      border-top: 1px solid var(--border);
      margin-top: 12px;
    }
    .btn-footer {
      font-family: var(--font);
      font-size: 11px;
      font-weight: 600;
      padding: 3px 12px;
      border: 1px solid;
      border-radius: 3px;
      cursor: pointer;
      background: transparent;
      transition: 0.12s ease;
    }
    .empty-state {
      text-align: center;
      padding: 32px 16px;
      color: var(--muted);
      font-size: 13px;
    }
  </style>
</head>
<body>
  <div id="app">
    <div class="empty-state">Loading diff...</div>
  </div>

  <script>
    var vscode;
    try {
      vscode = acquireVsCodeApi();
    } catch(e) {
      vscode = { postMessage: function(m) { console.log('postMessage:', m); } };
    }

    var state = { file: '', hunks: [], currentContent: '' };

    function esc(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    /**
     * Parse a hunk patch string into typed lines.
     * Patch format: "@@ header\n line1\n line2\n..."
     * Returns: [{ type: 'context'|'removed'|'added', text: string }]
     */
    function parseHunkLines(patch) {
      var lines = patch.split('\n');
      var result = [];
      var first = true;
      for (var i = 0; i < lines.length; i++) {
        if (first && lines[i].startsWith('@@')) {
          first = false;
          continue;
        }
        // Skip trailing empty string from split
        if (i === lines.length - 1 && lines[i] === '') continue;

        if (lines[i].startsWith('-')) {
          result.push({ type: 'removed', text: lines[i].substring(1) });
        } else if (lines[i].startsWith('+')) {
          result.push({ type: 'added', text: lines[i].substring(1) });
        } else {
          var t = lines[i].startsWith(' ') ? lines[i].substring(1) : lines[i];
          result.push({ type: 'context', text: t });
        }
      }
      return result;
    }

    function render() {
      var app = document.getElementById('app');
      var hunks = state.hunks;
      var file = state.file;

      if (!hunks || !hunks.length) {
        app.innerHTML = '<div class="empty-state">No changes to display. All hunks processed.</div>';
        return;
      }

      var html = '';
      html += '<div class="header-bar">';
      html += '<span class="header-filename">' + esc(file) + '</span>';
      html += '<span style="font-size:11px;color:var(--muted)">' + hunks.length + ' hunk(s)</span>';
      html += '</div>';

      for (var hi = 0; hi < hunks.length; hi++) {
        var hunk = hunks[hi];
        var lines = parseHunkLines(hunk.patch);

        html += '<div class="hunk" data-hunk-id="' + hunk.id + '">';
        html += '<div class="hunk-header">';
        html += '<span>' + esc(hunk.header) + '</span>';
        html += '<div class="hunk-actions">';
        html += '<button class="btn-mini btn-accept" data-action="acceptHunk" data-hunk-id="' + hunk.id + '">Accept</button>';
        html += '<button class="btn-mini btn-deny" data-action="denyHunk" data-hunk-id="' + hunk.id + '">Deny</button>';
        html += '</div>';
        html += '</div>';

        for (var li = 0; li < lines.length; li++) {
          var line = lines[li];
          var lineClass = '';
          var prefix = ' ';
          var editable = false;

          if (line.type === 'removed') {
            lineClass = 'line-removed';
            prefix = '-';
          } else if (line.type === 'added') {
            lineClass = 'line-added';
            prefix = '+';
            editable = true;
          } else {
            lineClass = 'line-context';
            prefix = ' ';
            editable = true;
          }

          html += '<div class="diff-line ' + lineClass + '"';
          if (editable) {
            html += ' contenteditable="true"';
            html += ' data-editable="true"';
          }
          html += ' data-hunk-id="' + hunk.id + '"';
          html += ' data-line-index="' + li + '"';
          html += ' data-line-type="' + line.type + '"';
          html += '>';
          html += '<span class="line-prefix">' + prefix + '</span>';
          html += esc(line.text);
          html += '</div>';
        }

        html += '</div>';
      }

      html += '<div class="footer-bar">';
      html += '<button class="btn-footer btn-accept" data-action="acceptAll">Accept All</button>';
      html += '<button class="btn-footer btn-deny" data-action="denyAll">Deny All</button>';
      html += '</div>';

      app.innerHTML = html;
      attachListeners();
    }

    function attachListeners() {
      // Hunk action buttons
      var actionBtns = document.querySelectorAll('[data-action]');
      for (var i = 0; i < actionBtns.length; i++) {
        actionBtns[i].addEventListener('click', function(e) {
          e.stopPropagation();
          var action = this.getAttribute('data-action');
          var hunkId = this.getAttribute('data-hunk-id');
          var msg = { command: action, file: state.file };
          if (hunkId !== null && hunkId !== undefined) {
            msg.hunkId = parseInt(hunkId, 10);
          }
          vscode.postMessage(msg);
        });
      }

      // Editable lines — send changes to extension on blur
      var editableLines = document.querySelectorAll('[data-editable="true"]');
      for (var j = 0; j < editableLines.length; j++) {
        editableLines[j].addEventListener('blur', function() {
          var hunkId = parseInt(this.getAttribute('data-hunk-id'), 10);
          var lineIndex = parseInt(this.getAttribute('data-line-index'), 10);
          var lineType = this.getAttribute('data-line-type');
          // Extract text without the prefix span
          var fullText = this.innerText || this.textContent || '';
          vscode.postMessage({
            command: 'editLine',
            file: state.file,
            hunkId: hunkId,
            lineIndex: lineIndex,
            lineType: lineType,
            newText: fullText
          });
        });

        // Also send on Enter key
        editableLines[j].addEventListener('keydown', function(e) {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            this.blur();
          }
        });
      }
    }

    // ── Message handler ──────────────────────────────────────────

    window.addEventListener('message', function(e) {
      var msg = e.data;
      switch (msg.command) {
        case 'renderDiff':
          state.file = msg.file;
          state.hunks = msg.hunks;
          state.currentContent = msg.currentContent;
          render();
          break;
        case 'hunkProcessed':
          // Remove hunk from list
          state.hunks = state.hunks.filter(function(h) { return h.id !== msg.hunkId; });
          render();
          break;
        case 'allProcessed':
          state.hunks = [];
          render();
          break;
        case 'closePanel':
          // Panel will be closed by extension
          break;
      }
    });

    // Notify extension we're ready
    vscode.postMessage({ command: 'ready' });
  </script>
</body>
</html>
```

- [ ] **Step 2: Verify the HTML file is well-formed**

Run: (manual check — open in browser or just verify no syntax errors in JS)
```bash
cd f:/node/cc-diff && node -e "require('fs').readFileSync('src/webview/diff.html','utf8')" > /dev/null && echo "File readable"
```
Expected: "File readable"

- [ ] **Step 3: Commit**

```bash
cd f:/node/cc-diff && git add src/webview/diff.html && git commit -m "feat: add custom diff panel webview template (diff.html)"
```

---

### Task 5: DiffPanelProvider.ts — Custom diff panel manager

**Files:**
- Create: `src/DiffPanelProvider.ts`

**Interfaces:**
- Consumes: `SnapshotManager.computeDiff`, `SnapshotManager.acceptHunk`, `SnapshotManager.denyHunk`, `SnapshotManager.acceptAll`, `SnapshotManager.denyAll` (from Task 1)
- Consumes: `diff.html` webview template (from Task 4)
- Produces: `DiffPanelProvider` class — consumed by extension.ts (Task 7)

- [ ] **Step 1: Create DiffPanelProvider.ts**

```typescript
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
        this._handleEditLine(file, lineType, newText);
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
          this._panel.dispose();
        }
        this._onPanelDisposed?.();
        break;

      case 'denyAll': {
        const result = this._snapshotManager.denyAll(file, this._workspaceRoot);
        if (!result.success) {
          vscode.window.showErrorMessage(`CC Diff: Failed to deny all — ${result.error}`);
          return;
        }
        this._panel?.webview.postMessage({ command: 'allProcessed' });
        if (this._panel) {
          this._panel.dispose();
        }
        this._onPanelDisposed?.();
        break;
      }
    }
  }

  /**
   * Write a line edit from the diff panel to the actual workspace file.
   * The diff panel sends edits on blur — we write immediately so the file
   * stays in sync with what the user sees.
   */
  private _handleEditLine(filePath: string, lineType: string, newText: string): void {
    if (lineType === 'removed') return; // Read-only lines

    const absPath = path.resolve(this._workspaceRoot, filePath);
    if (!fs.existsSync(absPath)) return;

    // Read current file, replace the edited line, write back
    // This is a simplified approach: we read full file, find matching line,
    // and replace. More sophisticated line-tracking could be added later.
    try {
      // For now, we just write directly — the user's edit is the ground truth
      // A more precise implementation would track line numbers
      let content = fs.readFileSync(absPath, 'utf8');
      const lines = content.split('\n');

      // Since we don't have exact line numbers, we reconstruct from the
      // diff context. For the initial implementation, read the full file
      // and let the webview handle line-by-line updates via line numbers.
      //
      // The webview sends us the new text — we need to map it back to
      // the actual file position. For simplicity v1: send line numbers
      // from the extension side.
    } catch {
      // Silently fail — edit will be lost on refresh
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
          this._panel.dispose();
        }
        this._onPanelDisposed?.();
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
        var initMsg = ${initState};
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
```

- [ ] **Step 2: Verify compile**

Run: `cd f:/node/cc-diff && npx tsc --noEmit`
Expected: The file may have errors due to the `state` variable usage in injected JS. Fix by using `window.state` or restructuring.

- [ ] **Step 3: Fix injected script to use proper scoping**

The injected script references `state` and `render()` which are in the global scope of diff.html. This is fine since they're `var` declarations at the top level.

Run: `cd f:/node/cc-diff && npx tsc --noEmit`
Expected: No TypeScript errors.

- [ ] **Step 4: Improve `_handleEditLine` to write edits to workspace file**

Replace the stub `_handleEditLine` with a working implementation. Since tracking line numbers across edits is complex, for v1 we use the hunk context to locate lines:

```typescript
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
```

Note: After Step 4, the `_handleEditLine` signature has changed from 3 params to 5. The call site in `_handleMessage`'s `editLine` case must be updated to match. This is done in Step 5.

- [ ] **Step 5: Update `_handleMessage` editLine case to pass all params**

Change the `editLine` case from:
```typescript
      case 'editLine':
        this._handleEditLine(file, lineType, newText);
        break;
```

To:
```typescript
      case 'editLine':
        this._handleEditLine(file, hunkId, lineIndex, lineType, newText);
        break;
```

- [ ] **Step 6: Verify compile and commit**

Run: `cd f:/node/cc-diff && npx tsc -p ./`
Expected: No errors.

```bash
cd f:/node/cc-diff && git add src/DiffPanelProvider.ts out/DiffPanelProvider.js && git commit -m "feat: add DiffPanelProvider — custom diff editor webview panel"
```

---

### Task 6: Rewrite WebviewProvider.ts + Update index.html

**Files:**
- Modify: `src/WebviewProvider.ts` (full rewrite)
- Modify: `src/webview/index.html`

**Interfaces:**
- Consumes: `SnapshotManager` (Task 1), `DiffPanelProvider.openDiff` (Task 5)
- Produces: sidebar webview file list + Accept/Deny per file

- [ ] **Step 1: Rewrite WebviewProvider.ts**

```typescript
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
          for (const f of files) {
            this._snapshotManager.denyAll(f, this._workspaceRoot);
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
```

- [ ] **Step 2: Update index.html — simplify to remove patchId**

The current index.html uses `data-patch` attribute in button handlers. Remove that since we no longer have patchId. The key change:

In the `render()` function, change:
```javascript
// Old: html += '<button class="btn btn-accept" data-action="acceptFile" data-file="' + escAttr(file.file) + '" data-patch="' + escAttr(file.patchId) + '">Accept</button>';
// New:
html += '<button class="btn btn-accept" data-action="acceptFile" data-file="' + escAttr(file.file) + '">Accept</button>';
```

And similarly for deny button. Also update `attachListeners` to not read `data-patch`.

Edit the file:

```html
<!-- Lines 278-279 -->
html += '<button class="btn btn-accept" data-action="acceptFile" data-file="' + escAttr(file.file) + '">Accept</button>';
html += '<button class="btn btn-deny" data-action="denyFile" data-file="' + escAttr(file.file) + '">Deny</button>';
```

And in `attachListeners()`:
```javascript
// Remove `var p = this.getAttribute('data-patch');` and `if (p) msg.patchId = p;`
```

- [ ] **Step 3: Verify compile**

Run: `cd f:/node/cc-diff && npx tsc -p ./`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
cd f:/node/cc-diff && git add src/WebviewProvider.ts out/WebviewProvider.js src/webview/index.html && git commit -m "feat: rewrite WebviewProvider + simplify index.html for snapshot model"
```

---

### Task 7: Update extension.ts + HooksManager.ts — Final wiring

**Files:**
- Modify: `src/extension.ts`
- Modify: `src/HooksManager.ts`

**Interfaces:**
- Consumes: `SnapshotManager` (Task 1), `WebviewProvider` (Task 6), `DiffPanelProvider` (Task 5), `HooksManager`

- [ ] **Step 1: Rewrite extension.ts**

```typescript
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { SnapshotManager } from './SnapshotManager';
import { WebviewProvider } from './WebviewProvider';
import { DiffPanelProvider } from './DiffPanelProvider';
import { HooksManager } from './HooksManager';

let snapshotManager: SnapshotManager;
let webviewProvider: WebviewProvider;
let diffPanelProvider: DiffPanelProvider;
let hooksManager: HooksManager;
let fileWatcher: vscode.FileSystemWatcher | undefined;
let outputChannel: vscode.OutputChannel;

function log(msg: string): void {
  const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
  outputChannel.appendLine(`[${ts}] ${msg}`);
}

export function activate(context: vscode.ExtensionContext): void {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return;
  }

  const workspaceRoot = path.resolve(workspaceFolders[0].uri.fsPath);

  // ── Output channel ──
  outputChannel = vscode.window.createOutputChannel('CC Diff', { log: true });
  context.subscriptions.push(outputChannel);
  log(`Extension activated — workspace: ${workspaceRoot}`);

  // ── Hooks auto-update ──
  hooksManager = new HooksManager(context.extensionPath);
  hooksManager.setLogger(log);
  log('Checking hook scripts for updates...');
  hooksManager.autoUpdate(workspaceRoot);

  // ── SnapshotManager ──
  snapshotManager = new SnapshotManager();
  snapshotManager.setLogger(log);
  snapshotManager.setWorkspaceRoot(workspaceRoot);
  snapshotManager.loadFiles(workspaceRoot);

  // ── DiffPanelProvider ──
  diffPanelProvider = new DiffPanelProvider(workspaceRoot, snapshotManager, outputChannel);
  // When diff panel is closed, refresh the sidebar
  diffPanelProvider.onPanelDisposed = () => {
    webviewProvider.refresh();
  };

  // ── WebviewProvider ──
  webviewProvider = new WebviewProvider(workspaceRoot, snapshotManager, outputChannel, diffPanelProvider);

  // ── Sidebar webview ──
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('cc-diff.view', webviewProvider)
  );

  // ── File watcher: index.json ──
  const watchPattern = new vscode.RelativePattern(
    workspaceFolders[0],
    '.claude/cc-diff/index.json'
  );

  fileWatcher = vscode.workspace.createFileSystemWatcher(watchPattern, false, false, false);
  context.subscriptions.push(fileWatcher);

  fileWatcher.onDidCreate((uri) => {
    log(`FileWatcher: index.json created — ${uri.fsPath}`);
    snapshotManager.loadFiles(workspaceRoot);
    webviewProvider.refresh();
    if (snapshotManager.getAllFiles().length > 0) {
      vscode.commands.executeCommand('cc-diff.view.focus');
    }
  });

  fileWatcher.onDidChange((uri) => {
    const before = snapshotManager.getAllFiles().length;
    log(`FileWatcher: index.json changed — ${uri.fsPath}`);
    snapshotManager.loadFiles(workspaceRoot);
    webviewProvider.refresh();
    const after = snapshotManager.getAllFiles().length;
    if (after > before) {
      vscode.commands.executeCommand('cc-diff.view.focus');
      log(`FileWatcher: auto-focused cc-diff view (files: ${before} → ${after})`);
    }
  });

  fileWatcher.onDidDelete(() => {
    log('FileWatcher: index.json deleted');
    snapshotManager.loadFiles(workspaceRoot);
    webviewProvider.refresh();
  });

  // ── Status bar ──
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  statusBarItem.command = 'cc-diff.focus';
  statusBarItem.text = '$(diff) CC Diff';
  statusBarItem.tooltip = 'Show CC Diff panel';
  context.subscriptions.push(statusBarItem);
  statusBarItem.show();

  // ── Commands ──
  context.subscriptions.push(
    vscode.commands.registerCommand('cc-diff.focus', () => {
      vscode.commands.executeCommand('cc-diff.view.focus');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cc-diff.setupHooks', async () => {
      log('Command: setupHooks invoked');
      try {
        await hooksManager.setupHooks(workspaceRoot);
        log('Command: setupHooks succeeded');
        vscode.window.showInformationMessage(
          'CC Diff: Hook 脚本安装成功！请查看 .claude/settings.json'
        );
      } catch (err: any) {
        log(`Command: setupHooks FAILED — ${err.message}`);
        vscode.window.showErrorMessage(`CC Diff: Hook 安装失败 — ${err.message}`);
      }
    })
  );

  log('Activation complete.');
}

export function deactivate(): void {
  log('Extension deactivated.');
  if (fileWatcher) {
    fileWatcher.dispose();
  }
}
```

Key changes from old extension.ts:
1. `DiffManager` → `SnapshotManager`
2. No more `changeListener` (`onDidChangeTextDocument`) — removed
3. No more `consolidatePatches` loop in file watcher callbacks
4. No more conflict handler setup
5. Watch path: `.claude/cc-diff/index.json` (moved up one level from `patches/index.json`)
6. `DiffPanelProvider` is created and wired to `WebviewProvider`
7. `onPanelDisposed` callback refreshes sidebar when diff panel closes

- [ ] **Step 2: Update HooksManager version marker**

In `src/HooksManager.ts`, change line:
```typescript
private static readonly VERSION_MARKER = 'cc-diff-hooks-v3';
```
to:
```typescript
private static readonly VERSION_MARKER = 'cc-diff-hooks-v4';
```

And update the source hooks directory path if needed (unchanged — still at `<extensionPath>/hooks`).

- [ ] **Step 3: Verify compile**

Run: `cd f:/node/cc-diff && npx tsc -p ./`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
cd f:/node/cc-diff && git add src/extension.ts out/extension.js src/HooksManager.ts out/HooksManager.js && git commit -m "feat: wire SnapshotManager + DiffPanelProvider in extension.ts, bump hooks to v4"
```

---

### Task 8: Update integration test

**Files:**
- Modify: `test/integration-test.sh`

- [ ] **Step 1: Rewrite integration test for new data model**

```bash
#!/usr/bin/env bash
# cc-diff integration test (v4 — snapshot model)
# Simulates a Claude Code session from hook triggering to diff display.
set -e

TEST_DIR="F:/tmp/cc-diff-integration-$$"
HOOKS_DIR="$(cd "$(dirname "$0")/../hooks" && pwd)"

echo "=== cc-diff Integration Test (v4) ==="
echo "Test directory: $TEST_DIR"

# Setup
rm -rf "$TEST_DIR"
mkdir -p "$TEST_DIR"
cd "$TEST_DIR"
git init
git config user.email "test@test.com"
git config user.name "Test"

# Create initial file
echo "line 1
line 2
line 3" > hello.txt
git add hello.txt && git commit -m "initial"

# --- Step 1: PreToolUse hook captures snapshot ---
echo ""
echo "--- Step 1: PreToolUse hook captures snapshot ---"
echo '{"hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"hello.txt","content":"new"},"session_id":"test-s1","cwd":"'"$TEST_DIR"'"}' | node "$HOOKS_DIR/pre-tool-use.js"
echo "Exit: $?"
echo "Snapshot:"
ls -la "$TEST_DIR/.claude/cc-diff/snapshots/hello.txt.snap"
echo "Content:"
cat "$TEST_DIR/.claude/cc-diff/snapshots/hello.txt.snap"

# --- Step 2: Simulate Claude Code editing the file ---
echo ""
echo "--- Step 2: Simulate Claude Code editing hello.txt ---"
echo "line 1
line 2 modified
line 3
line 4 added" > hello.txt
echo "Current hello.txt:"
cat hello.txt

# --- Step 3: SessionEnd hook verifies changes ---
echo ""
echo "--- Step 3: Stop hook verifies changes ---"
echo '{"hook_event_name":"Stop","session_id":"test-s1","cwd":"'"$TEST_DIR"'"}' | node "$HOOKS_DIR/session-end.js"
echo "SessionEnd exit: $?"

# --- Step 4: Verify index.json v2 ---
echo ""
echo "--- Step 4: Verify index.json v2 ---"
INDEX_PATH="$TEST_DIR/.claude/cc-diff/index.json"

echo "index.json:"
cat "$INDEX_PATH"
echo ""

# Verify version
if ! grep -q '"version": 2' "$INDEX_PATH"; then
  echo "FAIL: index.json version is not 2"
  exit 1
fi

# Verify file entry
if ! grep -q '"file": "hello.txt"' "$INDEX_PATH"; then
  echo "FAIL: index.json missing file entry"
  exit 1
fi

# Verify snapshot file reference
if ! grep -q '"snapshotFile": "hello.txt.snap"' "$INDEX_PATH"; then
  echo "FAIL: index.json missing snapshotFile"
  exit 1
fi

# Verify status
if ! grep -q '"status": "pending"' "$INDEX_PATH"; then
  echo "FAIL: index.json missing pending status"
  exit 1
fi

echo "PASS: index.json v2 structure validated"

# --- Step 5: Verify snapshot still exists (not deleted by session-end) ---
echo ""
echo "--- Step 5: Verify snapshot preserved ---"
if [ -f "$TEST_DIR/.claude/cc-diff/snapshots/hello.txt.snap" ]; then
  echo "PASS: snapshot preserved after session-end"
else
  echo "FAIL: snapshot was deleted"
  exit 1
fi

# --- Step 6: Test snapshot idempotency ---
echo ""
echo "--- Step 6: Test PreToolUse idempotency ---"
echo '{"hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"hello.txt","content":"new"},"session_id":"test-s2","cwd":"'"$TEST_DIR"'"}' | node "$HOOKS_DIR/pre-tool-use.js"
echo "Exit: $?"
# Snapshot should still have ORIGINAL content (not modified)
SNAP_CONTENT=$(cat "$TEST_DIR/.claude/cc-diff/snapshots/hello.txt.snap")
if [ "$SNAP_CONTENT" = "line 1
line 2
line 3" ]; then
  echo "PASS: snapshot unchanged (correct)"
else
  echo "FAIL: snapshot was overwritten: $SNAP_CONTENT"
  exit 1
fi

# --- Step 7: Test session-end cleanup when file reverted ---
echo ""
echo "--- Step 7: Test cleanup when file is reverted ---"
# Revert hello.txt to original content
echo "line 1
line 2
line 3" > hello.txt
echo '{"hook_event_name":"Stop","session_id":"test-s3","cwd":"'"$TEST_DIR"'"}' | node "$HOOKS_DIR/session-end.js"
echo "Exit: $?"
# Check that index.json was cleaned up
if [ -f "$INDEX_PATH" ]; then
  echo "index.json still exists. Content:"
  cat "$INDEX_PATH"
  # Should have 0 files or not exist
  if grep -q 'hello.txt' "$INDEX_PATH"; then
    echo "FAIL: hello.txt still in index after revert"
    exit 1
  else
    echo "PASS: hello.txt removed from index"
  fi
else
  echo "PASS: index.json deleted (no remaining files)"
fi

# --- Step 8: Test new file creation ---
echo ""
echo "--- Step 8: Test new file creation ---"
echo '{"hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"newfile.txt"},"session_id":"test-s4","cwd":"'"$TEST_DIR"'"}' | node "$HOOKS_DIR/pre-tool-use.js"
echo "Exit: $?"
if [ -f "$TEST_DIR/.claude/cc-diff/snapshots/newfile.txt.snap" ]; then
  echo "PASS: new file snapshot created"
  SNAP_CONTENT=$(cat "$TEST_DIR/.claude/cc-diff/snapshots/newfile.txt.snap")
  if [ -z "$SNAP_CONTENT" ]; then
    echo "PASS: new file snapshot is empty (correct)"
  else
    echo "FAIL: new file snapshot should be empty, got: $SNAP_CONTENT"
    exit 1
  fi
else
  echo "FAIL: new file snapshot not created"
  exit 1
fi

echo ""
echo "=== Integration test PASSED ==="
```

- [ ] **Step 2: Run the test**

```bash
cd f:/node/cc-diff && bash test/integration-test.sh
```
Expected: All steps PASS, exit code 0.

- [ ] **Step 3: Commit**

```bash
cd f:/node/cc-diff && git add test/integration-test.sh && git commit -m "test: update integration test for snapshot v4 model"
```

---

### Task 9: Cleanup — Delete DiffManager.ts and dead code

**Files:**
- Delete: `src/DiffManager.ts`
- Delete: `out/DiffManager.js`
- Modify: (none — just deletions)

- [ ] **Step 1: Delete DiffManager.ts**

```bash
cd f:/node/cc-diff && rm src/DiffManager.ts && rm -f out/DiffManager.js
```

- [ ] **Step 2: Verify full build still passes**

```bash
cd f:/node/cc-diff && npx tsc -p ./
```
Expected: Clean compile, no errors.

- [ ] **Step 3: Check for any remaining references to old types**

```bash
cd f:/node/cc-diff && grep -r "DiffManager" src/ --include="*.ts" || echo "No DiffManager references found"
```
Expected: "No DiffManager references found"

```bash
cd f:/node/cc-diff && grep -r "PatchEntry\|patchId\|patchFile" src/ --include="*.ts" || echo "No old type references found"
```
Expected: "No old type references found"

- [ ] **Step 4: Final type check**

```bash
cd f:/node/cc-diff && npx tsc --noEmit
```
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
cd f:/node/cc-diff && git add -A && git commit -m "chore: delete DiffManager.ts — replaced by SnapshotManager"
```

---

### Task 10: End-to-end verification

- [ ] **Step 1: Package the extension**

```bash
cd f:/node/cc-diff && powershell -File scripts/package.ps1 -SkipTests
```
Expected: VSIX created successfully.

- [ ] **Step 2: Full integration test**

```bash
cd f:/node/cc-diff && bash test/integration-test.sh
```
Expected: All tests PASS.

- [ ] **Step 3: Verify all commits are clean**

```bash
cd f:/node/cc-diff && git log --oneline -10
```
Expected: Clean commit history with all tasks represented.
