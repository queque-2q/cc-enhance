import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { applyPatch, parsePatch, type ParsedDiff } from 'diff';

// ======================================================================
// Types
// ======================================================================

export interface HunkData {
  id: number;
  header: string;
  patch: string;
}

export type FileStatus = 'pending' | 'accepted' | 'denied' | 'partial';

export interface FileEntry {
  file: string;
  hunks: HunkData[];
  status: FileStatus;
  acceptedHunks: Set<number>;
  deniedHunks: Set<number>;
}

export interface SessionData {
  sessionId: string;
  timestamp: number;
  files: Map<string, FileEntry>;
}

export interface DenyResult {
  file: string;
  hunkId?: number;
  success: boolean;
  message: string;
}

// ======================================================================
// DiffManager
// ======================================================================

export class DiffManager {
  private sessions: Map<string, SessionData> = new Map();

  // ------------------------------------------------------------------
  // Loading
  // ------------------------------------------------------------------

  /**
   * Scan .claude/cc-diff/patches/ and load all unprocessed sessions.
   * Idempotent -- already-loaded sessions are not reloaded.
   */
  loadSessions(workspaceRoot: string): void {
    const patchesDir = path.join(workspaceRoot, '.claude', 'cc-diff', 'patches');
    if (!fs.existsSync(patchesDir)) {
      return;
    }

    let sessionDirs: string[];
    try {
      sessionDirs = fs.readdirSync(patchesDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
    } catch {
      return;
    }

    for (const sessionId of sessionDirs) {
      if (this.sessions.has(sessionId)) {
        continue;
      }

      const sessionJsonPath = path.join(patchesDir, sessionId, 'session.json');
      if (!fs.existsSync(sessionJsonPath)) {
        continue;
      }

      let sessionMeta: { sessionId: string; timestamp: number; files: string[] };
      try {
        sessionMeta = JSON.parse(fs.readFileSync(sessionJsonPath, 'utf8'));
      } catch {
        continue;
      }

      const files = new Map<string, FileEntry>();

      for (const filePath of sessionMeta.files) {
        // filePath from session.json uses POSIX separators -- normalize to platform
        const normalizedPath = filePath.replace(/\//g, path.sep);

        const patchJsonPath = path.join(patchesDir, sessionId, filePath + '.patch.json');
        if (!fs.existsSync(patchJsonPath)) {
          continue;
        }

        let patchData: { file: string; hunks: HunkData[] };
        try {
          patchData = JSON.parse(fs.readFileSync(patchJsonPath, 'utf8'));
        } catch {
          continue;
        }

        // Store with POSIX path as key (matching session.json), normalized path in entry
        files.set(filePath, {
          file: normalizedPath,
          hunks: patchData.hunks,
          status: 'pending',
          acceptedHunks: new Set<number>(),
          deniedHunks: new Set<number>(),
        });
      }

      if (files.size > 0) {
        this.sessions.set(sessionId, {
          sessionId: sessionMeta.sessionId,
          timestamp: sessionMeta.timestamp,
          files,
        });
      }
    }

    // Sort by timestamp, oldest first
    this.sessions = new Map(
      [...this.sessions.entries()].sort(
        (a, b) => a[1].timestamp - b[1].timestamp
      )
    );
  }

  // ------------------------------------------------------------------
  // Accessors
  // ------------------------------------------------------------------

  getAllSessions(): SessionData[] {
    return [...this.sessions.values()];
  }

  getSession(sessionId: string): SessionData | undefined {
    return this.sessions.get(sessionId);
  }

  getFileEntry(sessionId: string, filePath: string): FileEntry | undefined {
    return this.sessions.get(sessionId)?.files.get(filePath);
  }

  isSessionComplete(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return true;
    return [...session.files.values()].every(
      f => f.status === 'accepted' || f.status === 'denied'
    );
  }

  // ------------------------------------------------------------------
  // File-level operations
  // ------------------------------------------------------------------

  /** Mark all hunks in a file as accepted. No filesystem changes needed. */
  acceptFile(sessionId: string, filePath: string): void {
    const entry = this.getFileEntry(sessionId, filePath);
    if (!entry) return;

    entry.status = 'accepted';
    entry.acceptedHunks = new Set(entry.hunks.map(h => h.id));
    entry.deniedHunks = new Set();
  }

  /** Reverse all unaccepted hunks in a file via `git apply --reverse`. */
  denyFile(sessionId: string, filePath: string, workspaceRoot: string): DenyResult {
    const entry = this.getFileEntry(sessionId, filePath);
    if (!entry) {
      return { file: filePath, success: false, message: 'File not found in session' };
    }

    const absPath = path.resolve(workspaceRoot, entry.file);
    const unacceptedHunks = entry.hunks.filter(
      h => !entry.acceptedHunks.has(h.id) && !entry.deniedHunks.has(h.id)
    );

    if (unacceptedHunks.length === 0) {
      return { file: filePath, success: true, message: 'No hunks to deny' };
    }

    // Try combined reverse patch first
    const combinedPatch = unacceptedHunks.map(h => h.patch).join('');
    if (this.applyReverseGit(absPath, workspaceRoot, combinedPatch)) {
      for (const h of unacceptedHunks) {
        entry.deniedHunks.add(h.id);
      }
      entry.status = 'denied';
      this.syncFileStatus(entry);
      return { file: filePath, success: true, message: 'All hunks reverted' };
    }

    // Fall back: try each hunk individually
    const results: string[] = [];
    for (const hunk of unacceptedHunks) {
      if (this.applyReverseGit(absPath, workspaceRoot, hunk.patch)) {
        entry.deniedHunks.add(hunk.id);
        results.push(`Hunk ${hunk.id}: reverted`);
      } else {
        results.push(`Hunk ${hunk.id}: skipped (conflict -- file was manually modified)`);
      }
    }

    entry.status = entry.deniedHunks.size === entry.hunks.length ? 'denied' : 'partial';
    this.syncFileStatus(entry);

    return {
      file: filePath,
      success: entry.deniedHunks.size === unacceptedHunks.length,
      message: results.join('; '),
    };
  }

  // ------------------------------------------------------------------
  // Hunk-level operations
  // ------------------------------------------------------------------

  acceptHunk(sessionId: string, filePath: string, hunkId: number): void {
    const entry = this.getFileEntry(sessionId, filePath);
    if (!entry) return;

    entry.acceptedHunks.add(hunkId);
    entry.deniedHunks.delete(hunkId);
    this.syncFileStatus(entry);
  }

  denyHunk(sessionId: string, filePath: string, hunkId: number, workspaceRoot: string): DenyResult {
    const entry = this.getFileEntry(sessionId, filePath);
    if (!entry) {
      return { file: filePath, hunkId, success: false, message: 'File not found in session' };
    }

    const hunk = entry.hunks.find(h => h.id === hunkId);
    if (!hunk) {
      return { file: filePath, hunkId, success: false, message: 'Hunk not found' };
    }

    const absPath = path.resolve(workspaceRoot, entry.file);
    if (this.applyReverseGit(absPath, workspaceRoot, hunk.patch)) {
      entry.deniedHunks.add(hunkId);
      this.syncFileStatus(entry);
      return { file: filePath, hunkId, success: true, message: 'Hunk reverted' };
    }

    return {
      file: filePath,
      hunkId,
      success: false,
      message: 'Conflict: file has been modified manually -- cannot cleanly revert',
    };
  }

  // ------------------------------------------------------------------
  // Bulk operations
  // ------------------------------------------------------------------

  acceptAll(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    for (const [, entry] of session.files) {
      entry.status = 'accepted';
      entry.acceptedHunks = new Set(entry.hunks.map(h => h.id));
      entry.deniedHunks = new Set();
    }
  }

  denyAll(sessionId: string, workspaceRoot: string): DenyResult[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];

    const results: DenyResult[] = [];
    for (const [filePath] of session.files) {
      results.push(this.denyFile(sessionId, filePath, workspaceRoot));
    }
    return results;
  }

  // ------------------------------------------------------------------
  // Diff Editor Preview
  // ------------------------------------------------------------------

  /**
   * Generate the "before" version of a file by reverse-applying all
   * unaccepted hunks. This is shown as the LEFT side of the diff editor.
   * Returns null if the file is not in any session.
   */
  getReverseContent(filePath: string, workspaceRoot: string, sessionId: string): string | null {
    const entry = this.getFileEntry(sessionId, filePath);
    if (!entry) return null;

    const absPath = path.resolve(workspaceRoot, entry.file);
    let currentContent: string;
    try {
      currentContent = fs.readFileSync(absPath, 'utf8');
    } catch {
      return '';
    }

    const activeHunks = entry.hunks.filter(
      h => !entry.acceptedHunks.has(h.id) && !entry.deniedHunks.has(h.id)
    );

    if (activeHunks.length === 0) {
      return currentContent;
    }

    const reversePatch = this.buildReversePatch(entry, activeHunks);

    const reversed = applyPatch(currentContent, reversePatch);
    if (reversed === false) {
      return currentContent;
    }
    return reversed;
  }

  /**
   * Check if any active (unprocessed) hunks conflict with current file state.
   */
  hasConflicts(filePath: string, workspaceRoot: string, sessionId: string): boolean {
    const entry = this.getFileEntry(sessionId, filePath);
    if (!entry) return false;

    const absPath = path.resolve(workspaceRoot, entry.file);
    if (!fs.existsSync(absPath)) return false;

    let currentContent: string;
    try {
      currentContent = fs.readFileSync(absPath, 'utf8');
    } catch {
      return false;
    }

    const activeHunks = entry.hunks.filter(
      h => !entry.acceptedHunks.has(h.id) && !entry.deniedHunks.has(h.id)
    );

    if (activeHunks.length === 0) return false;

    const reversePatch = this.buildReversePatch(entry, activeHunks);
    const result = applyPatch(currentContent, reversePatch);
    return result === false;
  }

  // ------------------------------------------------------------------
  // Cleanup
  // ------------------------------------------------------------------

  /**
   * Remove sessions where all files are processed and the session is older
   * than 24 hours. Deletes both in-memory state and disk files.
   */
  cleanOldSessions(workspaceRoot: string): void {
    const now = Date.now();
    const twentyFourHours = 24 * 60 * 60 * 1000;
    const toDelete: string[] = [];

    for (const [sessionId, session] of this.sessions) {
      if (!this.isSessionComplete(sessionId)) continue;
      if (now - session.timestamp < twentyFourHours) continue;
      toDelete.push(sessionId);
    }

    for (const sessionId of toDelete) {
      const sessionDir = path.join(workspaceRoot, '.claude', 'cc-diff', 'patches', sessionId);
      try {
        if (fs.existsSync(sessionDir)) {
          fs.rmSync(sessionDir, { recursive: true, force: true });
        }
      } catch {
        // Best effort cleanup
      }
      this.sessions.delete(sessionId);
    }
  }

  // ======================================================================
  // Private
  // ======================================================================

  /** Apply a reverse patch using `git apply --reverse`. */
  private applyReverseGit(absPath: string, workspaceRoot: string, patchText: string): boolean {
    if (!fs.existsSync(absPath)) return false;

    const tmpPatch = path.join(workspaceRoot, '.claude', 'cc-diff', '.tmp-reverse.patch');

    try {
      const dir = path.dirname(tmpPatch);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(tmpPatch, patchText, 'utf8');

      execSync(`git apply --reverse --verbose "${tmpPatch}"`, {
        cwd: workspaceRoot,
        stdio: 'pipe',
        timeout: 5000,
        windowsHide: true,
      });

      return true;
    } catch {
      return false;
    } finally {
      try { fs.unlinkSync(tmpPatch); } catch { /* ignore */ }
    }
  }

  /**
   * Build a reverse (new->old) patch from the selected hunks.
   * For each hunk, swaps the old/new coordinates and flips +/- lines.
   */
  private buildReversePatch(_entry: FileEntry, hunks: HunkData[]): string {
    const forwardPatch = hunks.map(h => h.patch).join('');
    const parsed: ParsedDiff[] = parsePatch(forwardPatch);

    const reversedDiffs = parsed.map(diff => ({
      ...diff,
      oldFileName: diff.newFileName,
      newFileName: diff.oldFileName,
      oldHeader: diff.newHeader,
      newHeader: diff.oldHeader,
      hunks: diff.hunks.map(hunk => ({
        ...hunk,
        oldStart: hunk.newStart,
        oldLines: hunk.newLines,
        newStart: hunk.oldStart,
        newLines: hunk.oldLines,
        lines: this.flipHunkLines(hunk.lines),
      })),
    }));

    return reversedDiffs.map(d => this.formatDiff(d)).join('');
  }

  /** Flip +/- prefix on each line. Context lines (space) stay unchanged. */
  private flipHunkLines(lines: string[]): string[] {
    return lines.map(line => {
      if (line.startsWith('+')) return '-' + line.slice(1);
      if (line.startsWith('-')) return '+' + line.slice(1);
      return line;
    });
  }

  /** Serialize a ParsedDiff back to unified diff text. */
  private formatDiff(diff: any): string {
    let output = '';
    output += `--- ${diff.oldFileName}\n`;
    output += `+++ ${diff.newFileName}\n`;
    for (const hunk of diff.hunks) {
      output += `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n`;
      output += hunk.lines.map((l: string) => (l.endsWith('\n') ? l : l + '\n')).join('');
    }
    return output;
  }

  /** Update file status based on accepted/denied hunk counts. */
  private syncFileStatus(entry: FileEntry): void {
    const total = entry.hunks.length;
    const processed = entry.acceptedHunks.size + entry.deniedHunks.size;

    if (processed === 0) {
      entry.status = 'pending';
    } else if (processed === total) {
      entry.status = entry.deniedHunks.size > 0 ? 'denied' : 'accepted';
    } else {
      entry.status = 'partial';
    }
  }
}
