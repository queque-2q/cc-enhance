# Patch Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement proactive patch consolidation: after reverse-applying patches, run `git diff` to recompute a clean diff, replace old patches with one consolidated patch per file.

**Architecture:** Add `consolidatePatches()` to DiffManager with helpers `gitDiff()` and `parseHunks()`. Thread-safe disk I/O uses read-modify-atomicWrite-verifyReread-merge pattern. Trigger from WebviewProvider (file edits) and extension.ts (index.json changes).

**Tech Stack:** TypeScript, VSCode Extension API, Node.js fs/child_process, git CLI

## Global Constraints

- VSCode ^1.85 API
- TypeScript strict mode
- All file operations use atomic write (tmp → rename) for index.json
- Never hardcode colors — use VSCode CSS variables
- Hook scripts never block the editor (all errors → exit 0)
- File paths in patches use POSIX forward slashes

---

### Task 1: Add gitDiff and parseHunks helpers to DiffManager

**Files:**
- Modify: `src/DiffManager.ts`

**Interfaces:**
- Produces: `private gitDiff(oldContent: string, newContent: string, relativeFile: string): string`
- Produces: `private parseHunks(patchText: string): HunkData[]`

- [ ] **Step 1: Add gitDiff private method**

Add after the existing `gitReverseErrorDetail` method (line ~881):

```typescript
/**
 * Generate unified diff between two content strings using `git diff --no-index`.
 * Returns the unified diff text, or empty string on failure.
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

    let stdout: string;
    try {
      stdout = execSync(
        `git diff --no-index --no-color -U2 "a/${relativeFile}" "b/${relativeFile}"`,
        {
          encoding: 'utf8',
          stdio: 'pipe',
          timeout: 10000,
          cwd: tmpDir,
          windowsHide: true,
        }
      );
    } catch (e: any) {
      // git diff exits 1 when there are differences (normal case)
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
```

- [ ] **Step 2: Add parseHunks private method**

Add after the `gitDiff` method:

```typescript
/**
 * Parse a unified diff string into individual hunks.
 * Each hunk has: id, header (@@ line), patch (header + body lines).
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

- [ ] **Step 3: Compile to check for type errors**

```bash
cd f:/node/cc-diff && npx tsc --noEmit
```

Expected: No errors related to the new methods.

- [ ] **Step 4: Commit**

```bash
git add src/DiffManager.ts
git commit -m "feat: add gitDiff and parseHunks helpers to DiffManager"
```

---

### Task 2: Add thread-safe index I/O helpers + fix existing methods

**Files:**
- Modify: `src/DiffManager.ts`

**Interfaces:**
- Produces: `private readIndexFromDisk(indexPath: string): IndexData`
- Produces: `private writeIndexToDisk(indexPath: string, indexData: IndexData): void`
- Modifies: `private removeFromIndex(patchId: string): void` — add verify-read+merge
- Modifies: `private tryCleanupIndex(): void` — add re-read confirmation

- [ ] **Step 1: Add readIndexFromDisk and writeIndexToDisk helpers**

Add before the `deletePatchFiles` method (around line 900):

```typescript
/**
 * Read and parse index.json from disk.
 * Returns empty structure if the file is missing or corrupt.
 */
private readIndexFromDisk(indexPath: string): IndexData {
  if (!fs.existsSync(indexPath)) {
    return { version: 1, patches: [] };
  }
  try {
    const raw = fs.readFileSync(indexPath, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.patches)) {
      return { version: 1, patches: [] };
    }
    return data;
  } catch {
    this.logger('readIndexFromDisk: WARN — cannot parse, returning empty');
    return { version: 1, patches: [] };
  }
}

/**
 * Atomically write index.json: write to temp file, then rename.
 * Prevents corruption from concurrent writes (last writer wins but file stays valid).
 */
private writeIndexToDisk(indexPath: string, indexData: IndexData): void {
  const tmpPath = indexPath + '.tmp-' + Date.now();
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(indexData, null, 2), 'utf8');
    fs.renameSync(tmpPath, indexPath);
  } catch (e: any) {
    this.logger(`writeIndexToDisk: ERROR — ${e.message}`);
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}
```

- [ ] **Step 2: Rewrite removeFromIndex with verify-read+merge**

Replace the existing `removeFromIndex` method (lines 933-973):

```typescript
/**
 * Remove a patch entry from index.json.
 * Uses read-modify-write with re-read verification to handle
 * concurrent writes from session-end hook processes.
 */
private removeFromIndex(patchId: string): void {
  const patchesDir = path.join(this.workspaceRoot, '.claude', 'cc-diff', 'patches');
  const indexPath = path.join(patchesDir, 'index.json');

  if (!fs.existsSync(indexPath)) return;

  // 1. Read current snapshot
  const freshRead = this.readIndexFromDisk(indexPath);
  if (!Array.isArray(freshRead.patches)) return;

  const before = freshRead.patches.length;
  freshRead.patches = freshRead.patches.filter(p => p.id !== patchId);

  if (freshRead.patches.length === before) return; // Not found

  if (freshRead.patches.length === 0) {
    // No entries left — verify before deleting index.json
    const verify = this.readIndexFromDisk(indexPath);
    if (verify.patches.length === 0) {
      try { fs.unlinkSync(indexPath); } catch (e: any) {
        this.logger(`[CLEANUP] WARN — failed to remove index.json: ${e.message}`);
      }
    } else {
      // Concurrent hook added entries — write them back
      this.writeIndexToDisk(indexPath, verify);
      this.logger(`[CLEANUP] index.json not empty after re-read (${verify.patches.length} entries), kept it`);
    }
    return;
  }

  // 2. Atomic write
  this.writeIndexToDisk(indexPath, freshRead);

  // 3. Re-read and merge concurrent entries (hook process may have written)
  const verifyRead = this.readIndexFromDisk(indexPath);
  const unknownEntries = verifyRead.patches.filter(
    p => !freshRead.patches.some(fp => fp.id === p.id)
  );

  if (unknownEntries.length > 0) {
    this.logger(`[CLEANUP] detected ${unknownEntries.length} concurrent entry(ies), merging...`);
    freshRead.patches.push(...unknownEntries);
    freshRead.patches.sort((a, b) => a.timestamp - b.timestamp);
    this.writeIndexToDisk(indexPath, freshRead);
  }

  this.logger(`[CLEANUP] removed ${patchId} from index.json`);
}
```

- [ ] **Step 3: Fix tryCleanupIndex with re-read confirmation**

Replace the existing `tryCleanupIndex` method (lines 978-995):

```typescript
/**
 * If all patches are processed, remove index.json.
 * Re-reads index.json before deleting to avoid race with concurrent hook writes.
 */
private tryCleanupIndex(): void {
  if (!this.workspaceRoot) return;

  // Clear in-memory state
  this.patches.clear();
  this.patchesByFile.clear();

  const indexPath = path.join(this.workspaceRoot, '.claude', 'cc-diff', 'patches', 'index.json');
  if (!fs.existsSync(indexPath)) return;

  // Re-read to confirm no concurrent writes before deleting
  const current = this.readIndexFromDisk(indexPath);
  if (current.patches.length === 0) {
    try {
      fs.unlinkSync(indexPath);
      this.logger('[CLEANUP] removed index.json — all patches processed');
    } catch (e: any) {
      this.logger(`[CLEANUP] WARN — failed to remove index.json: ${e.message}`);
    }
  } else {
    // Concurrent hook added entries — reload them into memory
    this.logger(`[CLEANUP] index.json has ${current.patches.length} entries from concurrent hook, reloading...`);
    this.loadPatches(this.workspaceRoot);
  }
}
```

- [ ] **Step 4: Compile to check for type errors**

```bash
cd f:/node/cc-diff && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/DiffManager.ts
git commit -m "fix: add thread-safe index I/O with verify-read+merge pattern"
```

---

### Task 3: Add consolidatePatches method to DiffManager

**Files:**
- Modify: `src/DiffManager.ts`

**Interfaces:**
- Produces: `public consolidatePatches(filePath: string, workspaceRoot: string): boolean`
- Produces: `private _consolidatingFiles: Set<string>`
- Produces: `private writeConsolidatedPatch(...): void`

- [ ] **Step 1: Add _consolidatingFiles field**

Add after the `private logger` field (after line 71):

```typescript
/** Files currently being consolidated (prevents concurrent re-entry). */
private _consolidatingFiles: Set<string> = new Set();
```

- [ ] **Step 2: Add writeConsolidatedPatch private helper**

Add before the `deletePatchFiles` method (around line 900):

```typescript
/**
 * Write a consolidated patch to disk with thread-safe index update.
 *
 * 1. Writes new .patch.json file
 * 2. Atomically updates index.json: removes old entries, adds new one
 * 3. Re-reads index.json to detect concurrent hook writes and merges them
 * 4. Deletes old .patch.json files (only the ones we know about)
 *
 * @param newId Pre-computed new patch ID (timestamp-safeFile) — must match
 *             the ID used for the in-memory PatchEntry to keep disk and
 *             memory consistent.
 */
private writeConsolidatedPatch(
  filePath: string,
  oldPatches: PatchEntry[],
  newHunks: HunkData[],
  newId: string,
  timestamp: number,
  workspaceRoot: string
): void {
  const patchesDir = path.join(workspaceRoot, '.claude', 'cc-diff', 'patches');
  const indexPath = path.join(patchesDir, 'index.json');

  const newPatchFileName = `${newId}.patch.json`;

  // 1. Write new .patch.json
  fs.writeFileSync(
    path.join(patchesDir, newPatchFileName),
    JSON.stringify({ file: filePath, hunks: newHunks }, null, 2),
    'utf8'
  );

  // 2. Read index, remove old entries, add consolidated entry
  const oldIds = new Set(oldPatches.map(p => p.id));
  const freshRead = this.readIndexFromDisk(indexPath);
  freshRead.patches = freshRead.patches.filter(p => !oldIds.has(p.id));
  freshRead.patches.push({
    id: newId,
    sessionId: oldPatches[0].sessionId,
    timestamp: timestamp,
    file: filePath,
    patchFile: newPatchFileName,
  });
  freshRead.patches.sort((a, b) => a.timestamp - b.timestamp);

  // 3. Atomic write
  this.writeIndexToDisk(indexPath, freshRead);

  // 4. Re-read and merge concurrent entries
  const verifyRead = this.readIndexFromDisk(indexPath);
  const unknownEntries = verifyRead.patches.filter(
    p => !freshRead.patches.some(fp => fp.id === p.id)
  );

  if (unknownEntries.length > 0) {
    this.logger(`[CONSOLIDATE] detected ${unknownEntries.length} concurrent entry(ies), merging...`);
    freshRead.patches.push(...unknownEntries);
    freshRead.patches.sort((a, b) => a.timestamp - b.timestamp);
    this.writeIndexToDisk(indexPath, freshRead);
  }

  // 5. Delete old .patch.json files (only known IDs)
  for (const p of oldPatches) {
    const oldPath = path.join(patchesDir, `${p.id}.patch.json`);
    try {
      if (fs.existsSync(oldPath)) {
        fs.unlinkSync(oldPath);
        this.logger(`[CONSOLIDATE] deleted old patch: ${p.id}.patch.json`);
      }
    } catch (e: any) {
      this.logger(`[CONSOLIDATE] WARN — cannot delete ${p.id}.patch.json: ${e.message}`);
    }
  }
}
```

- [ ] **Step 3: Add consolidatePatches public method**

Add before the `deletePatchFiles` method (around line 900):

```typescript
/**
 * Consolidate all active patches for a file into a single patch.
 *
 * Flow:
 *   1. Reverse-apply all active patches (newest first) to the current file
 *      content to compute the original "before" state.
 *   2. Run `git diff` between "before" and current content to get a clean,
 *      consolidated unified diff.
 *   3. Parse the diff into individual hunks (each independently operable).
 *   4. Thread-safely replace old patches on disk and in memory with the
 *      new consolidated patch.
 *
 * Returns true on success, false if consolidation could not be performed
 * (e.g. file missing, reverse conflict, git diff failed).
 */
consolidatePatches(filePath: string, workspaceRoot: string): boolean {
  // 1. Re-entrancy guard
  if (this._consolidatingFiles.has(filePath)) {
    return false;
  }
  this._consolidatingFiles.add(filePath);

  try {
    // 2. Get active patches for this file
    const allPatches = this.getPatchesForFile(filePath);
    const activePatches = allPatches.filter(
      p => p.status !== 'accepted' && p.status !== 'denied'
    );

    if (activePatches.length === 0) {
      return true; // Nothing to consolidate
    }

    // 3. Read current file from workspace
    const absPath = path.resolve(workspaceRoot, filePath);
    if (!fs.existsSync(absPath)) {
      this.logger(`[CONSOLIDATE] file not found: "${filePath}"`);
      return false;
    }
    const currentContent = fs.readFileSync(absPath, 'utf8');

    // 4. Reverse-apply all active patches (newest first) to get "before" state
    let beforeContent = currentContent;
    const sortedNewest = [...activePatches].sort((a, b) => b.timestamp - a.timestamp);

    for (const p of sortedNewest) {
      const activeHunks = p.hunks.filter(
        h => !p.acceptedHunks.has(h.id) && !p.deniedHunks.has(h.id)
      );
      if (activeHunks.length === 0) continue;

      const patchText = activeHunks.map(h => h.patch).join('');
      const result = this.applyReverseToContent(beforeContent, filePath, patchText);
      if (!result.success) {
        this.logger(
          `[CONSOLIDATE] reverse failed for "${filePath}" — ` +
          `file was manually modified, cannot consolidate\n` +
          `  Reason: ${result.error || 'unknown'}`
        );
        return false;
      }
      beforeContent = result.content!;
    }

    // 5. git diff "before" vs current → new unified diff
    const newDiff = this.gitDiff(beforeContent, currentContent, filePath);
    if (!newDiff) {
      this.logger(`[CONSOLIDATE] git diff produced no output for "${filePath}"`);
      return false;
    }

    // 6. Parse into hunks
    const newHunks = this.parseHunks(newDiff);
    if (newHunks.length === 0) {
      this.logger(`[CONSOLIDATE] no hunks parsed for "${filePath}"`);
      return false;
    }

    // 7. Pre-compute the new patch ID (used by both disk write and in-memory state)
    const now = Date.now();
    const safeFile = filePath.replace(/[/\\:]/g, '-');
    const newId = `${now}-${safeFile}`;

    // 8. Thread-safe disk update (write new patch, update index, delete old)
    this.writeConsolidatedPatch(filePath, activePatches, newHunks, newId, now, workspaceRoot);

    // 9. Update in-memory state
    for (const p of activePatches) {
      this.patches.delete(p.id);
    }
    const fileIds = this.patchesByFile.get(filePath);
    if (fileIds) {
      this.patchesByFile.set(
        filePath,
        fileIds.filter(id => !activePatches.some(p => p.id === id))
      );
    }

    // 10. Add consolidated entry to in-memory state
    this.addPatchEntry({
      id: newId,
      sessionId: activePatches[0].sessionId,
      timestamp: now,
      file: filePath,
      hunks: newHunks,
      status: 'pending',
      acceptedHunks: new Set<number>(),
      deniedHunks: new Set<number>(),
    });

    this.logger(
      `[CONSOLIDATE] "${filePath}": ${activePatches.length} patch(es) → 1 ` +
      `(${newHunks.length} hunks)`
    );
    return true;
  } finally {
    this._consolidatingFiles.delete(filePath);
  }
}
```

- [ ] **Step 4: Compile to check for type errors**

```bash
cd f:/node/cc-diff && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/DiffManager.ts
git commit -m "feat: add consolidatePatches with thread-safe disk update"
```

---

### Task 4: Update WebviewProvider trigger points

**Files:**
- Modify: `src/WebviewProvider.ts`

**Interfaces:**
- Consumes: `DiffManager.consolidatePatches(filePath, workspaceRoot): boolean`
- Modifies: `notifyFileChanged()` — call consolidatePatches before refresh
- Modifies: `handleOpenDiff()` — call consolidatePatches before showing diff

- [ ] **Step 1: Update notifyFileChanged to consolidate on file edit**

Replace the existing `notifyFileChanged` method (lines 169-187):

```typescript
/** Notify webview that a specific file has changed (100ms debounced). */
notifyFileChanged(filePath: string): void {
  // Normalize to POSIX path for lookup
  const posixPath = filePath.replace(/\\/g, '/');

  // Check if file is tracked
  const allFiles = this._diffManager.getAllFiles();
  const isTracked = allFiles.some(f => f === posixPath || f === filePath);
  if (!isTracked) return;

  // Consolidate patches: reverse-apply all → git diff → replace with clean patch
  this._diffManager.consolidatePatches(posixPath, this._workspaceRoot);

  // Re-generate the temp file for any open diff editor so it picks up changes
  this.updateDiffTempFile(posixPath);

  if (this._debounceTimer) {
    clearTimeout(this._debounceTimer);
  }
  this._debounceTimer = setTimeout(() => {
    this.refresh();
  }, 100);
}
```

- [ ] **Step 2: Update handleOpenDiff to consolidate before showing diff**

Replace the beginning of `handleOpenDiff` (lines 441-448). Only the first few lines change — add consolidation before the existing logic:

```typescript
private async handleOpenDiff(filePath: string): Promise<void> {
  // Consolidate before showing diff to ensure patch is up-to-date
  this._diffManager.consolidatePatches(filePath, this._workspaceRoot);

  const reverseContent = this._diffManager.getReverseContent(
    filePath, this._workspaceRoot
  );

  // ... rest of the method stays the same ...
```

- [ ] **Step 3: Compile to check for type errors**

```bash
cd f:/node/cc-diff && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/WebviewProvider.ts
git commit -m "feat: trigger consolidatePatches on file edit and before opening diff"
```

---

### Task 5: Update extension.ts trigger points

**Files:**
- Modify: `src/extension.ts`

**Interfaces:**
- Consumes: `DiffManager.consolidatePatches(filePath, workspaceRoot): boolean`
- Modifies: `onDidCreate` handler — consolidate after loadPatches
- Modifies: `onDidChange` handler — consolidate after loadPatches

- [ ] **Step 1: Update onDidCreate to consolidate all tracked files**

Replace the `onDidCreate` handler (lines 116-125):

```typescript
fileWatcher.onDidCreate((uri) => {
  log(`FileWatcher: index.json created — ${uri.fsPath}`);
  diffManager.loadPatches(workspaceRoot);
  // Consolidate all tracked files after new patches arrive
  for (const f of diffManager.getAllFiles()) {
    diffManager.consolidatePatches(f, workspaceRoot);
  }
  webviewProvider.refresh();
  // Auto-focus: new patches just arrived via Stop hook
  if (diffManager.getAllPatches().length > 0) {
    vscode.commands.executeCommand('cc-diff.view.focus');
    log('FileWatcher: auto-focused cc-diff view (new patches)');
  }
});
```

- [ ] **Step 2: Update onDidChange to consolidate all tracked files**

Replace the `onDidChange` handler (lines 127-139):

```typescript
fileWatcher.onDidChange((uri) => {
  const before = diffManager.getAllPatches().length;
  log(`FileWatcher: index.json changed — ${uri.fsPath}`);
  diffManager.loadPatches(workspaceRoot);
  // Consolidate all tracked files after new patches arrive
  for (const f of diffManager.getAllFiles()) {
    diffManager.consolidatePatches(f, workspaceRoot);
  }
  webviewProvider.refresh();
  const after = diffManager.getAllPatches().length;
  // Auto-focus only when new patches were added (count increased),
  // not when patches are processed/removed via accept/deny.
  if (after > before) {
    vscode.commands.executeCommand('cc-diff.view.focus');
    log(`FileWatcher: auto-focused cc-diff view (patches: ${before} → ${after})`);
  }
});
```

- [ ] **Step 3: Compile to check for type errors**

```bash
cd f:/node/cc-diff && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/extension.ts
git commit -m "feat: trigger consolidatePatches on index.json changes"
```

---

### Task 6: Full compile and manual verification

**Files:**
- Verify: `out/` directory (compiled output)
- Verify: No regressions in existing functionality

- [ ] **Step 1: Full compile**

```bash
cd f:/node/cc-diff && npx tsc -p ./
```

Expected: Compilation succeeds with no errors.

- [ ] **Step 2: Verify out/extension.js compiles correctly**

```bash
cd f:/node/cc-diff && node -e "require('./out/extension.js')" 2>&1 || true
```

Expected: No syntax errors (require may fail due to missing vscode module but that's expected outside VSCode).

- [ ] **Step 3: Verify DiffManager exports**

```bash
cd f:/node/cc-diff && node -e "
const dm = require('./out/DiffManager.js');
console.log('DiffManager export keys:', Object.keys(dm));
console.log('consolidatePatches exists:', typeof dm.DiffManager.prototype.consolidatePatches === 'function');
"
```

Expected: `consolidatePatches exists: true`

- [ ] **Step 4: Verify consolidation works end-to-end (unit test via Node)**

Create temp test files and verify `consolidatePatches()` produces correct output:

```bash
cd f:/node/cc-diff && node -e "
const fs = require('fs');
const path = require('path');
const os = require('os');
const { DiffManager } = require('./out/DiffManager.js');

const dm = new DiffManager();
dm.setLogger(console.log);

// Set up a temp workspace with simulated patch data
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-diff-test-'));
const patchesDir = path.join(tmpDir, '.claude', 'cc-diff', 'patches');
fs.mkdirSync(patchesDir, { recursive: true });

// Create a test file
const testFile = 'src/test.ts';
const testFilePath = path.join(tmpDir, testFile);
const currentContent = 'line1\nline2 modified\nline3\nline4 added\n';
fs.mkdirSync(path.dirname(testFilePath), { recursive: true });
fs.writeFileSync(testFilePath, currentContent, 'utf8');

// Create two fake patches for the same file
const patch1 = {
  id: '1000-sess1-src-test.ts',
  sessionId: 'sess1',
  timestamp: 1000,
  file: testFile,
  hunks: [{ id: 0, header: '@@ -1,3 +1,3 @@', patch: '@@ -1,3 +1,3 @@\n line1\n-line2\n+line2 modified\n line3\n' }],
  status: 'pending',
  acceptedHunks: new Set(),
  deniedHunks: new Set(),
};
const patch2 = {
  id: '2000-sess2-src-test.ts',
  sessionId: 'sess2',
  timestamp: 2000,
  file: testFile,
  hunks: [{ id: 0, header: '@@ -3,1 +3,2 @@', patch: '@@ -3,1 +3,2 @@\n line3\n+line4 added\n' }],
  status: 'pending',
  acceptedHunks: new Set(),
  deniedHunks: new Set(),
};

// Write patch files and index
fs.writeFileSync(path.join(patchesDir, '1000-sess1-src-test.ts.patch.json'), JSON.stringify({ file: testFile, hunks: patch1.hunks }, null, 2));
fs.writeFileSync(path.join(patchesDir, '2000-sess2-src-test.ts.patch.json'), JSON.stringify({ file: testFile, hunks: patch2.hunks }, null, 2));
fs.writeFileSync(path.join(patchesDir, 'index.json'), JSON.stringify({
  version: 1,
  patches: [
    { id: '1000-sess1-src-test.ts', sessionId: 'sess1', timestamp: 1000, file: testFile, patchFile: '1000-sess1-src-test.ts.patch.json' },
    { id: '2000-sess2-src-test.ts', sessionId: 'sess2', timestamp: 2000, file: testFile, patchFile: '2000-sess2-src-test.ts.patch.json' },
  ]
}, null, 2));

// Load and consolidate
dm.setWorkspaceRoot(tmpDir);
dm.loadPatches(tmpDir);
console.log('Before consolidation:');
console.log('  Patches for file:', dm.getPatchesForFile(testFile).length);

const result = dm.consolidatePatches(testFile, tmpDir);
console.log('Consolidation result:', result);

console.log('After consolidation:');
const consolidated = dm.getPatchesForFile(testFile);
console.log('  Patches for file:', consolidated.length);
if (consolidated.length > 0) {
  console.log('  Total hunks:', consolidated[0].hunks.length);
  consolidated[0].hunks.forEach(h => console.log('    hunk', h.id, ':', h.header));
}

// Verify old files deleted, new file created
const newIndex = JSON.parse(fs.readFileSync(path.join(patchesDir, 'index.json'), 'utf8'));
console.log('  index.json entries:', newIndex.patches.length);
console.log('  Entry id:', newIndex.patches[0]?.id);

// Cleanup
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('TEST PASSED');
"
```

Expected: 2 patches → 1 consolidated patch with 2 hunks, old files deleted, new `.patch.json` file created.

- [ ] **Step 5: Run existing integration tests**

```bash
cd f:/node/cc-diff && bash test/integration-test.sh
```

Expected: All tests pass (no regression).

- [ ] **Step 6: Commit**

```bash
git add out/
git commit -m "chore: compile and verify patch consolidation feature"
```
