# Patch Consolidation — 整合精简 diff patch

## 目标

当弹出 cc diff 窗口计算 snapshot 时（检测到标志文件变化 + 手动修改文件），
在逐一 `git apply --reverse` 后，再通过 `git diff` 重新计算 diff patch，
用新的合并后的 patch 替换当前的多条 patch，实现 diff patch 内容的整合精简。

## 触发时机

主动触发（检测到变化时立即合并）：

| 场景 | 触发点 | 处理 |
|------|--------|------|
| `index.json` 变化 | `extension.ts:FileWatcher.onDidChange/onDidCreate` | `loadPatches()` → 对新文件调用 `consolidatePatches()` |
| 手动修改文件 | `WebviewProvider.notifyFileChanged()` | 检测到 tracked file → `consolidatePatches()` |

## 核心逻辑

### `DiffManager.consolidatePatches(filePath): boolean`

```
输入: filePath (POSIX 路径)
流程:
  1. 防重入: 检查 _consolidatingFiles.has(filePath)，有则跳过
  2. _consolidatingFiles.add(filePath)
  3. 获取该文件所有 active patches（按时间升序）
  4. 逐一 reverse-apply → 得到 "before" 状态
      - 如果 reverse 失败 → 解锁，返回 false（文件已被手动修改，无法合并）
  5. git diff "before" vs 当前工作区文件 → 新的 unified diff
  6. parseHunks → 新的 hunk 列表（每个 hunk 保留独立 id）
  7. 线程安全地更新磁盘:
      a. freshRead = 读取当前 index.json
      b. 移除旧 patch 条目，添加合并后的新条目
      c. atomicWrite(tmp → rename)
      d. verifyRead = 重读 index.json
      e. 如果 verifyRead 中有 freshRead 中不存在的条目（hook 并发写入）:
         → 合并这些条目 → 重新 atomicWrite
  8. 删除旧的 .patch.json 文件（仅删已知 ID 的，不删 hook 新写入的）
  9. 写入新的合并 .patch.json 文件
  10. 更新内存 Map（移除旧 patches，添加合并后的新 patch）
  11. _consolidatingFiles.delete(filePath)
  12. 返回 true
```

### 合并后的数据模型

文件名格式简化为 `<timestamp>-<safeFile>.patch.json`（移除 sessionId）：

```
合并前:                                合并后:
index.json:                            index.json:
  { id: "t1-s1-src-foo.ts.patch.json"}   { id: "t3-src-foo.ts.patch.json" }
  { id: "t2-s2-src-foo.ts.patch.json"}  ← 一条记录

patches/                               patches/
  t1-s1-src-foo.ts.patch.json  ✗         t3-src-foo.ts.patch.json  ✓
  t2-s2-src-foo.ts.patch.json  ✗

合并后的 .patch.json:
{
  "file": "src/foo.ts",
  "hunks": [
    { "id": 0, "header": "@@ ... @@", "patch": "..." },
    { "id": 1, "header": "@@ ... @@", "patch": "..." }
  ]
}
```

- 文件名: `<timestamp>-<safeFile>.patch.json`
- patch ID: `<timestamp>-<safeFile>`
- 每个 hunk 独立保留 id → Accept/Deny 粒度不变

## 线程安全设计

### 并发模型

VSCode 扩展单线程（JS event loop），外部 session-end hook 是独立进程。
竞争发生在扩展 ↔ hook 进程之间。

### 精准删除

- 旧的 patch ID 在合并前从内存 Map 读取，已知且确定
- 删除时只按这些 ID 精确删除对应的 .patch.json 文件
- hook 新写入的文件（未知 ID）不受影响

### index.json 读-改-写竞争

使用"重读合并"策略：

1. `freshRead = readIndex()` — 获取当前快照
2. 在内存中修改（移除旧条目 + 添加合并条目）
3. `atomicWrite(tmp → rename)` — 原子写回
4. `verifyRead = readIndex()` — 立即重读
5. 如果 verifyRead 中出现 freshRead 中不存在的条目 → hook 并发写入了新条目
6. 将这些新条目合并进我们的修改 → 重新 atomicWrite

### 已有方法的加固

| 方法 | 风险 | 加固 |
|------|------|------|
| `removeFromIndex()` | hook 同时写入可能被覆盖 | 加重读合并 |
| `tryCleanupIndex()` | hook 刚写入新条目时 index.json 被误删 | 重读确认后再删 |

### 扩展内部防重入

- `_consolidatingFiles: Set<string>` 记录正在合并的文件
- `consolidatePatches()` 入口检查，已在合并中的文件跳过
- finally 块确保解锁

## 涉及文件

| 文件 | 修改内容 |
|------|----------|
| `src/DiffManager.ts` | 新增 `consolidatePatches()`、`_consolidatingFiles` Set、加固 `removeFromIndex()`/`tryCleanupIndex()` |
| `src/WebviewProvider.ts` | `notifyFileChanged()` 中调用 `consolidatePatches()`；`handleOpenDiff()` 改为基于合并后的 patch |
| `src/extension.ts` | `onDidChange/onDidCreate` 中 `loadPatches()` 后对新文件调用 `consolidatePatches()` |
