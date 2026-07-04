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

export type FileStatus = 'pending' | 'accepted' | 'denied' | 'partial';

/** A single session's changes to one file — the atomic unit of accept/deny. */
export interface PatchEntry {
  /** Unique ID: "<timestamp>-<sessionId>-<safeFile>" */
  id: string;
  sessionId: string;
  timestamp: number;
  file: string;
  hunks: HunkData[];
  status: FileStatus;
  acceptedHunks: Set<number>;
  deniedHunks: Set<number>;
}

/** Entry in the global index.json manifest. */
interface IndexEntry {
  id: string;
  sessionId: string;
  timestamp: number;
  file: string;
  patchFile: string;
}

interface IndexData {
  version: number;
  patches: IndexEntry[];
}

export interface DenyResult {
  /** The patch ID that was denied. */
  patchId: string;
  file: string;
  hunkId?: number;
  success: boolean;
  message: string;
  /** Git stderr output when the reverse patch fails (conflict detail). */
  errorDetail?: string;
}

interface ApplyResult {
  success: boolean;
  error?: string;
}

// ======================================================================
// DiffManager
// ======================================================================

export class DiffManager {
  /** All patches, keyed by patch ID. */
  private patches: Map<string, PatchEntry> = new Map();
  /** File → patch IDs, sorted by timestamp ascending. */
  private patchesByFile: Map<string, string[]> = new Map();
  private workspaceRoot: string = '';
  private logger: (msg: string) => void = () => {};
  /** Files currently being consolidated (prevents concurrent re-entry). */
  private _consolidatingFiles: Set<string> = new Set();
  private conflictHandler: ((file: string, hunkId: number | undefined, detail: string) => void) | null = null;

  /** Attach an output channel for logging conflict details. */
  setLogger(logger: (msg: string) => void): void {
    this.logger = logger;
  }

  /**
   * Attach a conflict handler — called when `git apply --reverse` hits
   * a conflict, so the extension layer can show a popup dialog.
   */
  setConflictHandler(handler: (file: string, hunkId: number | undefined, detail: string) => void): void {
    this.conflictHandler = handler;
  }

  /** Set workspace root for patch file cleanup. */
  setWorkspaceRoot(root: string): void {
    this.workspaceRoot = root;
  }

  // ------------------------------------------------------------------
  // Loading
  // ------------------------------------------------------------------

  /**
   * Scan .claude/cc-diff/patches/ and load all unprocessed patches.
   * Idempotent — already-loaded patches are not reloaded.
   *
   * Supports two formats:
   * 1. New: index.json + flat .patch.json files
   * 2. Old: <sessionId>/session.json + <file>.patch.json directories
   */
  loadPatches(workspaceRoot: string): void {
    const patchesDir = path.join(workspaceRoot, '.claude', 'cc-diff', 'patches');
    if (!fs.existsSync(patchesDir)) return;

    const indexPath = path.join(patchesDir, 'index.json');

    if (fs.existsSync(indexPath)) {
      this.loadFromIndex(patchesDir, indexPath);
    } else {
      this.loadFromSessionDirs(patchesDir);
    }
  }

  /** Load patches from the new flat index.json format. */
  private loadFromIndex(patchesDir: string, indexPath: string): void {
    let index: IndexData;
    try {
      index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    } catch {
      this.logger('loadPatches: WARN — cannot parse index.json');
      return;
    }

    if (!Array.isArray(index.patches)) {
      return;
    }

    let newCount = 0;

    for (const entry of index.patches) {
      if (this.patches.has(entry.id)) continue;

      const patchJsonPath = path.join(patchesDir, entry.patchFile);
      if (!fs.existsSync(patchJsonPath)) {
        this.logger(`loadPatches: WARN — missing patch file: ${entry.patchFile}`);
        continue;
      }

      let patchData: { file: string; hunks: HunkData[] };
      try {
        patchData = JSON.parse(fs.readFileSync(patchJsonPath, 'utf8'));
      } catch {
        this.logger(`loadPatches: WARN — cannot parse ${entry.patchFile}`);
        continue;
      }

      this.addPatchEntry({
        id: entry.id,
        sessionId: entry.sessionId,
        timestamp: entry.timestamp,
        file: entry.file,
        hunks: patchData.hunks,
        status: 'pending',
        acceptedHunks: new Set<number>(),
        deniedHunks: new Set<number>(),
      });

      newCount++;
    }

    if (newCount > 0) {
      this.logger(`loadPatches (index): ${newCount} new patch(es) — total: ${this.patches.size}`);
    }
  }

  /** Load patches from the old session-directory format (backward compat). */
  private loadFromSessionDirs(patchesDir: string): void {
    let sessionDirs: string[];
    try {
      sessionDirs = fs.readdirSync(patchesDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
    } catch {
      return;
    }

    let newCount = 0;

    for (const sessionId of sessionDirs) {
      const sessionJsonPath = path.join(patchesDir, sessionId, 'session.json');
      if (!fs.existsSync(sessionJsonPath)) continue;

      let sessionMeta: { sessionId: string; timestamp: number; files: string[] };
      try {
        sessionMeta = JSON.parse(fs.readFileSync(sessionJsonPath, 'utf8'));
      } catch {
        this.logger(`loadPatches: WARN — cannot parse ${sessionJsonPath}`);
        continue;
      }

      for (const filePath of sessionMeta.files) {
        // Generate a stable patch ID from session + file
        const safeFile = filePath.replace(/[\\/:]/g, '-');
        const patchId = `${sessionMeta.timestamp}-${sessionId}-${safeFile}`;

        if (this.patches.has(patchId)) continue;

        const patchJsonPath = path.join(patchesDir, sessionId, filePath + '.patch.json');
        if (!fs.existsSync(patchJsonPath)) {
          this.logger(`loadPatches: WARN — missing: ${patchJsonPath}`);
          continue;
        }

        let patchData: { file: string; hunks: HunkData[] };
        try {
          patchData = JSON.parse(fs.readFileSync(patchJsonPath, 'utf8'));
        } catch {
          this.logger(`loadPatches: WARN — cannot parse ${patchJsonPath}`);
          continue;
        }

        this.addPatchEntry({
          id: patchId,
          sessionId: sessionMeta.sessionId,
          timestamp: sessionMeta.timestamp,
          file: filePath,
          hunks: patchData.hunks,
          status: 'pending',
          acceptedHunks: new Set<number>(),
          deniedHunks: new Set<number>(),
        });

        newCount++;
      }
    }

    if (newCount > 0) {
      this.logger(`loadPatches (session dirs): ${newCount} new patch(es) — total: ${this.patches.size}`);
    }
  }

  /** Insert a patch entry into both the id→patch and file→patches indexes. */
  private addPatchEntry(entry: PatchEntry): void {
    this.patches.set(entry.id, entry);

    const existing = this.patchesByFile.get(entry.file);
    if (existing) {
      existing.push(entry.id);
      existing.sort((a, b) => {
        const pa = this.patches.get(a);
        const pb = this.patches.get(b);
        return (pa?.timestamp ?? 0) - (pb?.timestamp ?? 0);
      });
    } else {
      this.patchesByFile.set(entry.file, [entry.id]);
    }
  }

  // ------------------------------------------------------------------
  // Accessors
  // ------------------------------------------------------------------

  /** Return all patches sorted by timestamp ascending (oldest first). */
  getAllPatches(): PatchEntry[] {
    const all = [...this.patches.values()];
    all.sort((a, b) => a.timestamp - b.timestamp);
    return all;
  }

  /** Return all unique files that have patches. */
  getAllFiles(): string[] {
    return [...this.patchesByFile.keys()];
  }

  /** Return all patches for a file, sorted by timestamp ascending (oldest first). */
  getPatchesForFile(filePath: string): PatchEntry[] {
    const posixPath = filePath.replace(/\\/g, '/');
    const ids = this.patchesByFile.get(posixPath);
    if (!ids) return [];
    return ids.map(id => this.patches.get(id)!).filter(Boolean);
  }

  getPatch(patchId: string): PatchEntry | undefined {
    return this.patches.get(patchId);
  }

  /** Check if all patches are processed (accepted or denied). */
  isAllProcessed(): boolean {
    return [...this.patches.values()].every(
      p => p.status === 'accepted' || p.status === 'denied'
    );
  }

  // ------------------------------------------------------------------
  // Patch-level operations
  // ------------------------------------------------------------------

  /** Mark all hunks in a patch as accepted. No filesystem changes needed. */
  acceptPatch(patchId: string): void {
    const entry = this.patches.get(patchId);
    if (!entry) return;

    entry.status = 'accepted';
    entry.acceptedHunks = new Set(entry.hunks.map(h => h.id));
    entry.deniedHunks = new Set();

    // Clean up patch file — no longer needed
    this.deletePatchFiles(patchId);
  }

  /**
   * Reverse (deny) a single patch by applying `git apply --reverse`.
   *
   * When the file has newer patches layered on top, those must be reversed
   * first and then re-applied, because the current file content includes
   * their changes. The strategy:
   *
   * 1. Find the patch and all newer patches for the same file
   * 2. Reverse newer patches first (newest → this patch)
   * 3. Reverse this patch
   * 4. Re-apply the newer patches as forward patches
   *
   * If any step fails, the file is left unchanged and an error is returned.
   */
  denyPatch(patchId: string, workspaceRoot: string): DenyResult {
    const entry = this.patches.get(patchId);
    if (!entry) {
      return { patchId, file: '', success: false, message: 'Patch not found' };
    }

    const absPath = path.resolve(workspaceRoot, entry.file);
    if (!fs.existsSync(absPath)) {
      return { patchId, file: entry.file, success: false, message: `File not found: ${entry.file}` };
    }

    // Read current file content
    let currentContent: string;
    try {
      currentContent = fs.readFileSync(absPath, 'utf8');
    } catch {
      return { patchId, file: entry.file, success: false, message: 'Cannot read file' };
    }

    // Get all patches for this file (sorted oldest → newest)
    const allPatches = this.getPatchesForFile(entry.file);
    const patchIndex = allPatches.findIndex(p => p.id === patchId);
    if (patchIndex === -1) {
      return { patchId, file: entry.file, success: false, message: 'Patch not found in file index' };
    }

    // Patches newer than the target (need to be reversed first, then re-applied)
    const newerPatches = allPatches.slice(patchIndex + 1);
    // Unaccepted hunks in the target patch
    const targetHunks = entry.hunks.filter(
      h => !entry.acceptedHunks.has(h.id) && !entry.deniedHunks.has(h.id)
    );

    if (targetHunks.length === 0) {
      entry.status = 'denied';
      this.syncPatchStatus(entry);
      this.deletePatchFiles(patchId);
      return { patchId, file: entry.file, success: true, message: 'No hunks to deny' };
    }

    // Build the reverse operations in order (newest first):
    // 1. Reverse newer patches' hunks (newest → oldest among newer)
    // 2. Reverse this patch's target hunks
    // Then re-apply newer patches in forward order (oldest → newest among newer)

    const targetPatch = targetHunks.map(h => h.patch).join('');

    // Step 1 & 2: Reverse newer patches + target in newest-first order
    let content = currentContent;
    const reversePatches: { patchText: string; label: string }[] = [];

    // Add newer patches in reverse order
    for (let i = newerPatches.length - 1; i >= 0; i--) {
      const np = newerPatches[i];
      const activeHunks = np.hunks.filter(
        h => !np.acceptedHunks.has(h.id) && !np.deniedHunks.has(h.id)
      );
      if (activeHunks.length > 0) {
        reversePatches.push({
          patchText: activeHunks.map(h => h.patch).join(''),
          label: `newer patch ${np.id}`,
        });
      }
    }

    // Add target patch
    reversePatches.push({ patchText: targetPatch, label: 'target patch' });

    // Execute all reverses
    for (const rp of reversePatches) {
      const result = this.applyReverseToContent(content, entry.file, rp.patchText);
      if (!result.success) {
        this.logger(
          `[CONFLICT] denyPatch "${entry.file}" — reverse ${rp.label} failed\n` +
          `  Reason: ${result.error || 'unknown'}`
        );
        if (this.conflictHandler) {
          this.conflictHandler(entry.file, undefined, result.error || 'unknown');
        }
        return {
          patchId,
          file: entry.file,
          success: false,
          message: `Conflict: cannot reverse ${rp.label} — file was modified`,
          errorDetail: result.error,
        };
      }
      content = result.content!;
    }

    // Step 3: Re-apply newer patches (forward, oldest first)
    for (const np of newerPatches) {
      const activeHunks = np.hunks.filter(
        h => !np.acceptedHunks.has(h.id) && !np.deniedHunks.has(h.id)
      );
      if (activeHunks.length === 0) continue;

      const forwardPatch = activeHunks.map(h => h.patch).join('');
      const result = this.applyForwardToContent(content, entry.file, forwardPatch);
      if (!result.success) {
        // This should not normally fail — the forward and reverse should cancel out.
        // If it does, the file is in an inconsistent state.
        this.logger(
          `[ERROR] denyPatch "${entry.file}" — re-apply newer patch ${np.id} FAILED\n` +
          `  Reason: ${result.error || 'unknown'}\n` +
          `  FILE MAY BE IN AN INCONSISTENT STATE!`
        );
        if (this.conflictHandler) {
          this.conflictHandler(entry.file, undefined, `Re-apply failed after reverse: ${result.error}`);
        }
        return {
          patchId,
          file: entry.file,
          success: false,
          message: `Re-apply of newer patch ${np.id} failed — file may be corrupted`,
          errorDetail: result.error,
        };
      }
      content = result.content!;
    }

    // Write the result back
    fs.writeFileSync(absPath, content, 'utf8');

    // Mark target hunks as denied
    for (const h of targetHunks) {
      entry.deniedHunks.add(h.id);
    }
    entry.status = entry.deniedHunks.size === entry.hunks.length ? 'denied' : 'partial';
    this.syncPatchStatus(entry);

    this.logger(`[OK] denyPatch "${entry.file}" (${patchId}) — reverted cleanly`);

    // Clean up if fully processed
    if (entry.status === 'denied') {
      this.deletePatchFiles(patchId);
    }

    return { patchId, file: entry.file, success: true, message: 'Patch reverted' };
  }

  // ------------------------------------------------------------------
  // Hunk-level operations
  // ------------------------------------------------------------------

  acceptHunk(patchId: string, hunkId: number): void {
    const entry = this.patches.get(patchId);
    if (!entry) return;

    entry.acceptedHunks.add(hunkId);
    entry.deniedHunks.delete(hunkId);
    this.syncPatchStatus(entry);

    // Clean up if fully processed
    if (entry.status === 'accepted') {
      this.deletePatchFiles(patchId);
    }
  }

  /**
   * Reverse a single hunk. Falls back to per-hunk reverse if the
   * combined reverse fails (same layered approach as denyPatch).
   */
  denyHunk(patchId: string, hunkId: number, workspaceRoot: string): DenyResult {
    const entry = this.patches.get(patchId);
    if (!entry) {
      return { patchId, file: '', hunkId, success: false, message: 'Patch not found' };
    }

    const hunk = entry.hunks.find(h => h.id === hunkId);
    if (!hunk) {
      return { patchId, file: entry.file, hunkId, success: false, message: 'Hunk not found' };
    }

    const absPath = path.resolve(workspaceRoot, entry.file);
    if (!fs.existsSync(absPath)) {
      return { patchId, file: entry.file, hunkId, success: false, message: `File not found: ${entry.file}` };
    }

    // For hunk-level deny, use the same approach as applyReverseGit —
    // try a direct reverse on the workspace file
    const hunkResult = this.applyReverseGit(absPath, workspaceRoot, hunk.patch, entry.file);
    if (hunkResult.success) {
      entry.deniedHunks.add(hunkId);
      this.syncPatchStatus(entry);
      this.logger(`[OK] denyHunk "${entry.file}" hunk ${hunkId} — reverted cleanly`);

      if (entry.status === 'denied') {
        this.deletePatchFiles(patchId);
      }

      return { patchId, file: entry.file, hunkId, success: true, message: 'Hunk reverted' };
    }

    // Conflict — log and return detail
    this.logger(
      `[CONFLICT] denyHunk "${entry.file}" hunk ${hunkId} — cannot revert\n` +
      `  Reason: ${hunkResult.error || 'unknown'}`
    );

    if (this.conflictHandler) {
      this.conflictHandler(entry.file, hunkId, hunkResult.error || 'unknown');
    }

    return {
      patchId,
      file: entry.file,
      hunkId,
      success: false,
      message: 'Conflict: file has been modified manually — cannot cleanly revert',
      errorDetail: hunkResult.error,
    };
  }

  // ------------------------------------------------------------------
  // Bulk operations
  // ------------------------------------------------------------------

  /** Accept all patches. */
  acceptAll(): void {
    for (const [, entry] of this.patches) {
      entry.status = 'accepted';
      entry.acceptedHunks = new Set(entry.hunks.map(h => h.id));
      entry.deniedHunks = new Set();
      this.deletePatchFiles(entry.id);
    }
    // Clean up index.json
    this.tryCleanupIndex();
  }

  /**
   * Deny (reverse) all patches. Processes files in reverse chronological
   * order (newest first) so layered patches undo correctly.
   */
  denyAll(workspaceRoot: string): DenyResult[] {
    const results: DenyResult[] = [];

    // Get all patch IDs sorted newest-first
    const allPatches = this.getAllPatches();
    allPatches.reverse(); // newest first

    for (const entry of allPatches) {
      if (entry.status === 'accepted' || entry.status === 'denied') continue;
      results.push(this.denyPatch(entry.id, workspaceRoot));
    }

    const conflicts = results.filter(r => !r.success);
    if (conflicts.length > 0) {
      this.logger(
        `[SUMMARY] denyAll: ${conflicts.length}/${results.length} patch(es) had conflicts`
      );
    } else {
      this.logger(`[SUMMARY] denyAll: all ${results.length} patch(es) reverted`);
    }

    return results;
  }

  // ------------------------------------------------------------------
  // Diff Editor Preview
  // ------------------------------------------------------------------

  /**
   * Generate the "before" version of a file by reverse-applying all
   * active hunks from all patches for the file, in reverse chronological
   * order (newest first).
   * Returns null if the file is not tracked.
   */
  getReverseContent(filePath: string, workspaceRoot: string): string | null {
    const posixPath = filePath.replace(/\\/g, '/');
    const absPath = path.resolve(workspaceRoot, posixPath);
    let currentContent: string;
    try {
      currentContent = fs.readFileSync(absPath, 'utf8');
    } catch {
      return '';
    }

    const allPatches = this.getPatchesForFile(posixPath);
    if (allPatches.length === 0) return null;

    // Collect all active hunks from all patches, ordered newest-first
    const reverseOps: { patchText: string; label: string }[] = [];
    for (let i = allPatches.length - 1; i >= 0; i--) {
      const p = allPatches[i];
      const activeHunks = p.hunks.filter(
        h => !p.acceptedHunks.has(h.id) && !p.deniedHunks.has(h.id)
      );
      if (activeHunks.length > 0) {
        reverseOps.push({
          patchText: activeHunks.map(h => h.patch).join(''),
          label: `patch ${p.id}`,
        });
      }
    }

    if (reverseOps.length === 0) return currentContent;

    // Apply reverses in order (newest first)
    let content = currentContent;
    for (const op of reverseOps) {
      const result = this.applyReverseToContent(content, posixPath, op.patchText);
      if (!result.success) {
        // If reverse fails, return current content as-is (caller handles)
        return currentContent;
      }
      content = result.content!;
    }

    return content;
  }

  /**
   * Try reverse-applying active hunks and return the git error detail
   * (stderr) when a conflict occurs, or null if the patch applies cleanly.
   */
  getReverseConflictDetail(filePath: string, workspaceRoot: string): string | null {
    const posixPath = filePath.replace(/\\/g, '/');
    const absPath = path.resolve(workspaceRoot, posixPath);
    if (!fs.existsSync(absPath)) return null;

    let currentContent: string;
    try {
      currentContent = fs.readFileSync(absPath, 'utf8');
    } catch {
      return null;
    }

    const allPatches = this.getPatchesForFile(posixPath);
    if (allPatches.length === 0) return null;

    // Build combined reverse patch (all active hunks, newest first)
    const parts: string[] = [];
    for (let i = allPatches.length - 1; i >= 0; i--) {
      const p = allPatches[i];
      const activeHunks = p.hunks.filter(
        h => !p.acceptedHunks.has(h.id) && !p.deniedHunks.has(h.id)
      );
      for (const h of activeHunks) {
        parts.push(h.patch);
      }
    }

    if (parts.length === 0) return null;
    return this.gitReverseErrorDetail(currentContent, posixPath, parts.join(''));
  }

  /**
   * Check if any active (unprocessed) hunks conflict with current file state.
   */
  hasConflicts(filePath: string, workspaceRoot: string): boolean {
    const posixPath = filePath.replace(/\\/g, '/');
    const absPath = path.resolve(workspaceRoot, posixPath);
    if (!fs.existsSync(absPath)) return false;

    let currentContent: string;
    try {
      currentContent = fs.readFileSync(absPath, 'utf8');
    } catch {
      return false;
    }

    const allPatches = this.getPatchesForFile(posixPath);
    if (allPatches.length === 0) return false;

    // Build combined reverse patch
    const parts: string[] = [];
    for (let i = allPatches.length - 1; i >= 0; i--) {
      const p = allPatches[i];
      const activeHunks = p.hunks.filter(
        h => !p.acceptedHunks.has(h.id) && !p.deniedHunks.has(h.id)
      );
      for (const h of activeHunks) {
        parts.push(h.patch);
      }
    }

    if (parts.length === 0) return false;
    return !this.gitReverseCheck(currentContent, posixPath, parts.join(''));
  }

  // ======================================================================
  // Private — git-based patch operations
  // ======================================================================

  /**
   * Apply a reverse patch to a file using `git apply --reverse`.
   * Returns { success: true } on clean apply, or { success: false, error }.
   */
  private applyReverseGit(absPath: string, workspaceRoot: string, patchText: string, relativeFile: string): ApplyResult {
    if (!fs.existsSync(absPath)) {
      return { success: false, error: `File not found: ${absPath}` };
    }

    const tmpPatch = path.join(workspaceRoot, '.claude', 'cc-diff', '.tmp-reverse.patch');

    try {
      const dir = path.dirname(tmpPatch);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const posixPath = relativeFile.replace(/\\/g, '/');
      const fullPatch = `--- a/${posixPath}\n+++ b/${posixPath}\n` + patchText;
      fs.writeFileSync(tmpPatch, fullPatch, 'utf8');

      execSync(`git apply --reverse --verbose "${tmpPatch}"`, {
        cwd: workspaceRoot,
        stdio: 'pipe',
        timeout: 5000,
        windowsHide: true,
      });

      return { success: true };
    } catch (e: any) {
      const stderr = e.stderr?.toString() || e.message || 'Unknown git error';
      return { success: false, error: stderr };
    } finally {
      try { fs.unlinkSync(tmpPatch); } catch { /* ignore */ }
    }
  }

  /**
   * Reverse-apply a patch to content in a temp directory.
   * Returns { success: true, content } or { success: false, error }.
   */
  private applyReverseToContent(currentContent: string, relativeFile: string, hunkPatch: string): { success: boolean; content?: string; error?: string } {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-diff-'));
    try {
      const fileDir = path.join(tmpDir, path.dirname(relativeFile));
      if (fileDir !== tmpDir) {
        fs.mkdirSync(fileDir, { recursive: true });
      }
      const tmpFile = path.join(tmpDir, relativeFile);
      fs.writeFileSync(tmpFile, currentContent, 'utf8');

      const posixPath = relativeFile.replace(/\\/g, '/');
      const fullPatch = `--- a/${posixPath}\n+++ b/${posixPath}\n` + hunkPatch;
      const patchFile = path.join(tmpDir, 'reverse.patch');
      fs.writeFileSync(patchFile, fullPatch, 'utf8');

      try {
        execSync(`git apply --reverse "${patchFile}"`, {
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
      }
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }

  /**
   * Forward-apply a patch to content in a temp directory.
   * Returns { success: true, content } or { success: false, error }.
   */
  private applyForwardToContent(currentContent: string, relativeFile: string, hunkPatch: string): { success: boolean; content?: string; error?: string } {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-diff-'));
    try {
      const fileDir = path.join(tmpDir, path.dirname(relativeFile));
      if (fileDir !== tmpDir) {
        fs.mkdirSync(fileDir, { recursive: true });
      }
      const tmpFile = path.join(tmpDir, relativeFile);
      fs.writeFileSync(tmpFile, currentContent, 'utf8');

      const posixPath = relativeFile.replace(/\\/g, '/');
      const fullPatch = `--- a/${posixPath}\n+++ b/${posixPath}\n` + hunkPatch;
      const patchFile = path.join(tmpDir, 'forward.patch');
      fs.writeFileSync(patchFile, fullPatch, 'utf8');

      try {
        execSync(`git apply "${patchFile}"`, {
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
      }
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }

  /**
   * Check if a reverse patch applies cleanly using `git apply --reverse --check`.
   */
  private gitReverseCheck(currentContent: string, relativeFile: string, hunkPatch: string): boolean {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-diff-'));
    try {
      const fileDir = path.join(tmpDir, path.dirname(relativeFile));
      if (fileDir !== tmpDir) {
        fs.mkdirSync(fileDir, { recursive: true });
      }
      const tmpFile = path.join(tmpDir, relativeFile);
      fs.writeFileSync(tmpFile, currentContent, 'utf8');

      const posixPath = relativeFile.replace(/\\/g, '/');
      const fullPatch = `--- a/${posixPath}\n+++ b/${posixPath}\n` + hunkPatch;
      const patchFile = path.join(tmpDir, 'check.patch');
      fs.writeFileSync(patchFile, fullPatch, 'utf8');

      try {
        execSync(`git apply --reverse --check "${patchFile}"`, {
          cwd: tmpDir,
          stdio: 'pipe',
          timeout: 5000,
          windowsHide: true,
        });
        return true;
      } catch {
        return false;
      }
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }

  /**
   * Try `git apply --reverse` on a temp copy and return the git error
   * detail (stderr) when the patch fails to apply, or null if clean.
   */
  private gitReverseErrorDetail(currentContent: string, relativeFile: string, hunkPatch: string): string | null {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-diff-'));
    try {
      const fileDir = path.join(tmpDir, path.dirname(relativeFile));
      if (fileDir !== tmpDir) {
        fs.mkdirSync(fileDir, { recursive: true });
      }
      const tmpFile = path.join(tmpDir, relativeFile);
      fs.writeFileSync(tmpFile, currentContent, 'utf8');

      const posixPath = relativeFile.replace(/\\/g, '/');
      const fullPatch = `--- a/${posixPath}\n+++ b/${posixPath}\n` + hunkPatch;
      const patchFile = path.join(tmpDir, 'error-check.patch');
      fs.writeFileSync(patchFile, fullPatch, 'utf8');

      try {
        execSync(`git apply --reverse "${patchFile}"`, {
          cwd: tmpDir,
          stdio: 'pipe',
          timeout: 5000,
          windowsHide: true,
        });
        return null;
      } catch (e: any) {
        return e.stderr?.toString() || e.message || 'Unknown git error';
      }
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }

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

  /** Update patch status based on accepted/denied hunk counts. */
  private syncPatchStatus(entry: PatchEntry): void {
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

  // ------------------------------------------------------------------
  // Patch file cleanup
  // ------------------------------------------------------------------

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
  consolidatePatches(filePath: string, workspaceRoot: string): { success: boolean; hadConflict: boolean } {
    // 1. Re-entrancy guard
    if (this._consolidatingFiles.has(filePath)) {
      return { success: false, hadConflict: false };
    }
    this._consolidatingFiles.add(filePath);

    let hadConflict = false;

    try {
      // 2. Get active patches for this file
      const allPatches = this.getPatchesForFile(filePath);
      const activePatches = allPatches.filter(
        p => p.status !== 'accepted' && p.status !== 'denied'
      );

      if (activePatches.length <= 1) {
        return { success: true, hadConflict: false }; // Nothing to consolidate (1 patch = already consolidated)
      }

      // 3. Read current file from workspace
      const absPath = path.resolve(workspaceRoot, filePath);
      if (!fs.existsSync(absPath)) {
        this.logger(`[CONSOLIDATE] file not found: "${filePath}"`);
        return { success: false, hadConflict: false };
      }
      const currentContent = fs.readFileSync(absPath, 'utf8');

      // 4. Reverse-apply all active patches (newest first) to get "before" state
      let beforeContent = currentContent;
      const sortedNewest = [...activePatches].sort((a, b) => b.timestamp - a.timestamp);

      let conflictingPatchIndex = -1;

      for (let i = 0; i < sortedNewest.length; i++) {
        const p = sortedNewest[i];
        const activeHunks = p.hunks.filter(
          h => !p.acceptedHunks.has(h.id) && !p.deniedHunks.has(h.id)
        );
        if (activeHunks.length === 0) continue;

        const patchText = activeHunks.map(h => h.patch).join('');
        const result = this.applyReverseToContent(beforeContent, filePath, patchText);
        if (!result.success) {
          this.logger(
            `[CONSOLIDATE] reverse conflict for "${filePath}" — ` +
            `hunk overlap at patch ${p.id}, stopping reverse chain\n` +
            `  Reason: ${result.error || 'unknown'}`
          );
          hadConflict = true;
          conflictingPatchIndex = i;
          break; // Stop reversing — beforeContent keeps its current (partially-reversed) state
        }
        beforeContent = result.content!;
      }

      // 5. Collect fresh hunks from successfully-reversed patches (via git diff)
      //    and preserve hunks from conflicting / unprocessed patches.
      const newHunks: HunkData[] = [];

      if (beforeContent !== currentContent) {
        // Some patches reversed cleanly — diff the partially-reversed state
        const newDiff = this.gitDiff(beforeContent, currentContent, filePath);
        if (newDiff) {
          const freshHunks = this.parseHunks(newDiff);
          newHunks.push(...freshHunks);
          this.logger(
            `[CONSOLIDATE] "${filePath}": ${freshHunks.length} hunk(s) from fresh diff` +
            (hadConflict ? ' (partial reversal)' : '')
          );
        }
      }

      // 6. Preserve hunks from conflicting patch and all older unprocessed patches
      if (hadConflict) {
        let preservedCount = 0;
        for (let i = conflictingPatchIndex; i < sortedNewest.length; i++) {
          const p = sortedNewest[i];
          const activeHunks = p.hunks.filter(
            h => !p.acceptedHunks.has(h.id) && !p.deniedHunks.has(h.id)
          );
          for (const h of activeHunks) {
            newHunks.push({
              id: 0, // re-assigned below
              header: h.header,
              patch: h.patch,
            });
            preservedCount++;
          }
        }
        this.logger(
          `[CONSOLIDATE] "${filePath}": ${preservedCount} hunk(s) preserved from conflicting/older patches`
        );
      }

      // 7. Re-assign sequential hunk IDs
      for (let i = 0; i < newHunks.length; i++) {
        newHunks[i].id = i;
      }

      if (newHunks.length === 0) {
        this.logger(`[CONSOLIDATE] no hunks for "${filePath}" — nothing to persist`);
        return { success: false, hadConflict };
      }

      // 8. Pre-compute the new patch ID (used by both disk write and in-memory state)
      const now = Date.now();
      const safeFile = filePath.replace(/[/\\:]/g, '-');
      const newId = `${now}-${safeFile}`;

      // 9. Thread-safe disk update (write new patch, update index, delete old)
      this.writeConsolidatedPatch(filePath, activePatches, newHunks, newId, now, workspaceRoot);

      // 10. Update in-memory state
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

      // 11. Add consolidated entry to in-memory state?
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
        `(${newHunks.length} hunks)${hadConflict ? ' [had conflict]' : ''}`
      );
      return { success: true, hadConflict };
    } finally {
      this._consolidatingFiles.delete(filePath);
    }
  }

  /**
   * Delete the .patch.json file for a patch and remove its entry
   * from index.json. If the index is empty afterward, delete it too.
   */
  private deletePatchFiles(patchId: string): void {
    if (!this.workspaceRoot) return;

    const entry = this.patches.get(patchId);
    if (!entry) return;

    const patchesDir = path.join(this.workspaceRoot, '.claude', 'cc-diff', 'patches');

    // Determine the patch file name from the entry ID
    const patchFileName = `${patchId}.patch.json`;
    const patchPath = path.join(patchesDir, patchFileName);

    try {
      if (fs.existsSync(patchPath)) {
        fs.unlinkSync(patchPath);
        this.logger(`[CLEANUP] deleted patch file: ${patchFileName}`);
      }
    } catch (e: any) {
      this.logger(`[CLEANUP] WARN — failed to delete patch file "${patchFileName}": ${e.message}`);
    }

    // Remove from index.json
    this.removeFromIndex(patchId);
  }

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
}
