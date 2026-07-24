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
  branch?: string;
}

interface IndexEntryV2 {
  file: string;
  snapshotFile: string;
  sessionId: string;
  timestamp: number;
  status: string;
  branch?: string;
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

  // ------------------------------------------------------------------
  // Loading
  // ------------------------------------------------------------------

  /**
   * Load tracked files from index.json v2.
   * Skips v1 format (which has `patches` array).
   * Idempotent — clears and reloads each call.
   */
  loadFiles(workspaceRoot: string): void {
    this.workspaceRoot = workspaceRoot;
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
        branch: entry.branch,
      });
    }

    if (this.files.size > 0) {
      this.logger(`loadFiles: ${this.files.size} tracked file(s)`);
    }
  }

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

  // ------------------------------------------------------------------
  // Git branch helpers
  // ------------------------------------------------------------------

  /** Get the current git branch name, or null if not in a git repo. */
  getCurrentGitBranch(): string | null {
    if (!this.workspaceRoot) return null;

    const tryGitBranch = (cwd: string): string | null => {
      try {
        return execSync('git rev-parse --abbrev-ref HEAD', {
          cwd,
          encoding: 'utf8',
          stdio: 'pipe',
          timeout: 5000,
          windowsHide: true,
        }).trim();
      } catch {
        return null;
      }
    };

    // Try workspace root first
    const branch = tryGitBranch(this.workspaceRoot);
    if (branch) return branch;

    // Fall back: try the directories of tracked files
    for (const filePath of this.files.keys()) {
      const absPath = path.resolve(this.workspaceRoot, filePath);
      const fileDir = path.dirname(absPath);
      const branch2 = tryGitBranch(fileDir);
      if (branch2) return branch2;
    }

    return null;
  }

  /** Return tracked files whose branch differs from the given current branch. */
  getMismatchedFiles(currentBranch: string): TrackedFile[] {
    const mismatched: TrackedFile[] = [];
    for (const file of this.files.values()) {
      // Only compare if the entry has a branch recorded (legacy entries skip)
      if (file.branch && file.branch !== currentBranch) {
        mismatched.push(file);
      }
    }
    return mismatched;
  }

  /**
   * Remove a single tracked file: delete snapshot, remove from index,
   * and remove from in-memory map. Safe to call multiple times.
   */
  removeTrackedFile(filePath: string): void {
    const entry = this.getFileEntry(filePath);
    if (!entry) return;

    // Delete snapshot file
    const snapPath = this.getSnapshotPath(filePath);
    try { if (fs.existsSync(snapPath)) fs.unlinkSync(snapPath); } catch {}

    // Remove from index.json
    this.removeFromIndex(filePath);

    // Remove from in-memory map
    this.files.delete(entry.file);

    this.logger(`[removeTrackedFile] "${filePath}" — cleaned up`);
  }

  // ------------------------------------------------------------------
  // Diff computation
  // ------------------------------------------------------------------

  /**
   * Compute unified diff between snapshot and current workspace file.
   * Returns parsed hunks ready for the diff panel.
   */
  computeDiff(filePath: string, workspaceRoot: string): HunkData[] {
    // Treat missing snapshot as empty (file creation scenario)
    const snapshotContent = this.getSnapshotContent(filePath) ?? '';

    const absPath = path.resolve(workspaceRoot, filePath);
    let currentContent = '';
    try {
      currentContent = fs.readFileSync(absPath, 'utf8');
    } catch {
      // File doesn't exist — treat as empty (file deletion scenario)
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
          `git diff -b --no-index --no-color -U1 "a/${posixPath}" "b/${posixPath}"`,
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
    // Remove trailing empty element from split to avoid appending '\n' to it
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
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

      // Debug: log the patch being applied
      this.logger(`[applyHunkToContent] reverse=${reverse} file="${relativeFile}"`);
      this.logger(`[applyHunkToContent] content length: ${content.length}`);
      this.logger(`[applyHunkToContent] patch (${fullPatch.length} bytes):\n${fullPatch}`);

      const cmd = reverse
        ? `git apply --unidiff-zero --reverse "${patchFile}"`
        : `git apply --unidiff-zero "${patchFile}"`;
      this.logger(`[applyHunkToContent] cmd: ${cmd}`);
      execSync(cmd, {
        cwd: tmpDir,
        stdio: 'pipe',
        timeout: 5000,
        windowsHide: true,
      });

      const resultContent = fs.readFileSync(tmpFile, 'utf8');
      this.logger(`[applyHunkToContent] SUCCESS — result content length: ${resultContent.length}`);
      return { success: true, content: resultContent };
    } catch (e: any) {
      const stderr = e.stderr?.toString() || e.message || 'Unknown git error';
      this.logger(`[applyHunkToContent] FAILED — ${stderr}`);
      return { success: false, error: stderr };
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }

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
    // Treat missing snapshot as empty (file creation scenario)
    const currentContent = this.getSnapshotContent(filePath) ?? '';

    // Forward-apply hunk to snapshot content
    const result = this.applyHunkToContent(currentContent, filePath, hunk.patch, /* reverse */ false);
    if (!result.success) {
      this.logger(`[acceptHunk] FAILED for "${filePath}" hunk ${hunk.id}: ${result.error}`);
      return { success: false, error: result.error };
    }

    // Write updated snapshot (create snapshots dir if needed)
    if (snapPath) {
      fs.mkdirSync(path.dirname(snapPath), { recursive: true });
      fs.writeFileSync(snapPath, result.content!, 'utf8');
    }

    // Check if all changes are now accepted (snapshot matches current file)
    const absPath = path.resolve(workspaceRoot, filePath);
    let workspaceContent = '';
    try { workspaceContent = fs.readFileSync(absPath, 'utf8'); } catch {}

    if (result.content === workspaceContent) {
      // All changes accepted — clean up
      this.removeFromIndex(filePath);
      this.files.delete(entry.file);
      try { if (snapPath) fs.unlinkSync(snapPath); } catch {}
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

    // Read current file content — empty if file doesn't exist (deletion scenario)
    let currentContent: string;
    try {
      currentContent = fs.readFileSync(absPath, 'utf8');
    } catch {
      currentContent = '';
    }

    // Reverse-apply hunk to current file content
    const result = this.applyHunkToContent(currentContent, filePath, hunk.patch, /* reverse */ true);
    if (!result.success) {
      this.logger(`[denyHunk] FAILED for "${filePath}" hunk ${hunk.id}: ${result.error}`);
      return { success: false, error: result.error };
    }

    // Write reverted content back to workspace file
    const revertedContent = result.content!;
    if (revertedContent === '') {
      // Result is empty — delete the file (creation was fully denied)
      try { fs.unlinkSync(absPath); } catch { /* file already gone */ }
    } else {
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, revertedContent, 'utf8');
    }

    // Check if all changes are now denied (snapshot matches current file)
    // Treat missing snapshot as empty (file creation scenario)
    const snapshotContent = this.getSnapshotContent(filePath) ?? '';
    if (snapshotContent === revertedContent) {
      // All changes reverted — clean up
      this.removeFromIndex(filePath);
      this.files.delete(entry.file);
      const snapPath = this.getSnapshotPath(filePath);
      try { fs.unlinkSync(snapPath); } catch {}
      this.logger(`[denyHunk] "${filePath}" — all changes reverted, cleaned up`);
    }

    return { success: true };
  }

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

    // Treat missing snapshot as empty (file creation scenario)
    const snapshotContent = this.getSnapshotContent(filePath) ?? '';

    const absPath = path.resolve(workspaceRoot, filePath);

    if (snapshotContent === '' && !fs.existsSync(absPath)) {
      // Both sides empty — nothing to do, just clean up
      this.removeFromIndex(filePath);
      this.files.delete(entry.file);
      this.logger(`[denyAll] "${filePath}" — nothing to revert, cleaned up`);
      return { success: true };
    }

    if (snapshotContent === '') {
      // File was newly created — deny means delete the file
      try {
        fs.unlinkSync(absPath);
      } catch (e: any) {
        return { success: false, error: `Cannot delete file: ${e.message}` };
      }
    } else {
      // Normal revert: overwrite current file with snapshot content
      try {
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, snapshotContent, 'utf8');
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    }

    // Clean up
    const snapPath = this.getSnapshotPath(filePath);
    try { if (fs.existsSync(snapPath)) fs.unlinkSync(snapPath); } catch {}

    this.removeFromIndex(filePath);
    this.files.delete(entry.file);
    this.logger(`[denyAll] "${filePath}" — reverted to snapshot, cleaned up`);

    return { success: true };
  }

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
      // Write empty version first, then verify (same pattern as non-empty case)
      try { fs.unlinkSync(indexPath); } catch (e: any) {
        this.logger(`[removeFromIndex] WARN — failed to delete index.json: ${e.message}`);
      }

      // Re-read to catch concurrent hook additions
      const verify = this.readIndexFromDisk(indexPath);
      if (verify && verify.files.length > 0) {
        // Concurrent hook added entries while we were deleting — restore them
        this.writeIndexToDisk(indexPath, verify);
        this.logger(`[removeFromIndex] restored ${verify.files.length} concurrent entry(ies)`);
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
}
