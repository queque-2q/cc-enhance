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
}
