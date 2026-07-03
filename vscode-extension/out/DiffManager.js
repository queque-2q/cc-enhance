"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DiffManager = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const diff_1 = require("diff");
// ======================================================================
// DiffManager
// ======================================================================
class DiffManager {
    sessions = new Map();
    // ------------------------------------------------------------------
    // Loading
    // ------------------------------------------------------------------
    /**
     * Scan .claude/cc-diff/patches/ and load all unprocessed sessions.
     * Idempotent -- already-loaded sessions are not reloaded.
     */
    loadSessions(workspaceRoot) {
        const patchesDir = path.join(workspaceRoot, '.claude', 'cc-diff', 'patches');
        if (!fs.existsSync(patchesDir)) {
            return;
        }
        let sessionDirs;
        try {
            sessionDirs = fs.readdirSync(patchesDir, { withFileTypes: true })
                .filter(d => d.isDirectory())
                .map(d => d.name);
        }
        catch {
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
            let sessionMeta;
            try {
                sessionMeta = JSON.parse(fs.readFileSync(sessionJsonPath, 'utf8'));
            }
            catch {
                continue;
            }
            const files = new Map();
            for (const filePath of sessionMeta.files) {
                // filePath from session.json uses POSIX separators -- normalize to platform
                const normalizedPath = filePath.replace(/\//g, path.sep);
                const patchJsonPath = path.join(patchesDir, sessionId, filePath + '.patch.json');
                if (!fs.existsSync(patchJsonPath)) {
                    continue;
                }
                let patchData;
                try {
                    patchData = JSON.parse(fs.readFileSync(patchJsonPath, 'utf8'));
                }
                catch {
                    continue;
                }
                // Store with POSIX path as key (matching session.json), normalized path in entry
                files.set(filePath, {
                    file: normalizedPath,
                    hunks: patchData.hunks,
                    status: 'pending',
                    acceptedHunks: new Set(),
                    deniedHunks: new Set(),
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
        this.sessions = new Map([...this.sessions.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp));
    }
    // ------------------------------------------------------------------
    // Accessors
    // ------------------------------------------------------------------
    getAllSessions() {
        return [...this.sessions.values()];
    }
    getSession(sessionId) {
        return this.sessions.get(sessionId);
    }
    getFileEntry(sessionId, filePath) {
        return this.sessions.get(sessionId)?.files.get(filePath);
    }
    isSessionComplete(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session)
            return true;
        return [...session.files.values()].every(f => f.status === 'accepted' || f.status === 'denied');
    }
    // ------------------------------------------------------------------
    // File-level operations
    // ------------------------------------------------------------------
    /** Mark all hunks in a file as accepted. No filesystem changes needed. */
    acceptFile(sessionId, filePath) {
        const entry = this.getFileEntry(sessionId, filePath);
        if (!entry)
            return;
        entry.status = 'accepted';
        entry.acceptedHunks = new Set(entry.hunks.map(h => h.id));
        entry.deniedHunks = new Set();
    }
    /** Reverse all unaccepted hunks in a file via `git apply --reverse`. */
    denyFile(sessionId, filePath, workspaceRoot) {
        const entry = this.getFileEntry(sessionId, filePath);
        if (!entry) {
            return { file: filePath, success: false, message: 'File not found in session' };
        }
        const absPath = path.resolve(workspaceRoot, entry.file);
        const unacceptedHunks = entry.hunks.filter(h => !entry.acceptedHunks.has(h.id) && !entry.deniedHunks.has(h.id));
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
        const results = [];
        for (const hunk of unacceptedHunks) {
            if (this.applyReverseGit(absPath, workspaceRoot, hunk.patch)) {
                entry.deniedHunks.add(hunk.id);
                results.push(`Hunk ${hunk.id}: reverted`);
            }
            else {
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
    acceptHunk(sessionId, filePath, hunkId) {
        const entry = this.getFileEntry(sessionId, filePath);
        if (!entry)
            return;
        entry.acceptedHunks.add(hunkId);
        entry.deniedHunks.delete(hunkId);
        this.syncFileStatus(entry);
    }
    denyHunk(sessionId, filePath, hunkId, workspaceRoot) {
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
    acceptAll(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session)
            return;
        for (const [, entry] of session.files) {
            entry.status = 'accepted';
            entry.acceptedHunks = new Set(entry.hunks.map(h => h.id));
            entry.deniedHunks = new Set();
        }
    }
    denyAll(sessionId, workspaceRoot) {
        const session = this.sessions.get(sessionId);
        if (!session)
            return [];
        const results = [];
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
    getReverseContent(filePath, workspaceRoot, sessionId) {
        const entry = this.getFileEntry(sessionId, filePath);
        if (!entry)
            return null;
        const absPath = path.resolve(workspaceRoot, entry.file);
        let currentContent;
        try {
            currentContent = fs.readFileSync(absPath, 'utf8');
        }
        catch {
            return '';
        }
        const activeHunks = entry.hunks.filter(h => !entry.acceptedHunks.has(h.id) && !entry.deniedHunks.has(h.id));
        if (activeHunks.length === 0) {
            return currentContent;
        }
        const reversePatch = this.buildReversePatch(entry, activeHunks);
        const reversed = (0, diff_1.applyPatch)(currentContent, reversePatch);
        if (reversed === false) {
            return currentContent;
        }
        return reversed;
    }
    /**
     * Check if any active (unprocessed) hunks conflict with current file state.
     */
    hasConflicts(filePath, workspaceRoot, sessionId) {
        const entry = this.getFileEntry(sessionId, filePath);
        if (!entry)
            return false;
        const absPath = path.resolve(workspaceRoot, entry.file);
        if (!fs.existsSync(absPath))
            return false;
        let currentContent;
        try {
            currentContent = fs.readFileSync(absPath, 'utf8');
        }
        catch {
            return false;
        }
        const activeHunks = entry.hunks.filter(h => !entry.acceptedHunks.has(h.id) && !entry.deniedHunks.has(h.id));
        if (activeHunks.length === 0)
            return false;
        const reversePatch = this.buildReversePatch(entry, activeHunks);
        const result = (0, diff_1.applyPatch)(currentContent, reversePatch);
        return result === false;
    }
    // ------------------------------------------------------------------
    // Cleanup
    // ------------------------------------------------------------------
    /**
     * Remove sessions where all files are processed and the session is older
     * than 24 hours. Deletes both in-memory state and disk files.
     */
    cleanOldSessions(workspaceRoot) {
        const now = Date.now();
        const twentyFourHours = 24 * 60 * 60 * 1000;
        const toDelete = [];
        for (const [sessionId, session] of this.sessions) {
            if (!this.isSessionComplete(sessionId))
                continue;
            if (now - session.timestamp < twentyFourHours)
                continue;
            toDelete.push(sessionId);
        }
        for (const sessionId of toDelete) {
            const sessionDir = path.join(workspaceRoot, '.claude', 'cc-diff', 'patches', sessionId);
            try {
                if (fs.existsSync(sessionDir)) {
                    fs.rmSync(sessionDir, { recursive: true, force: true });
                }
            }
            catch {
                // Best effort cleanup
            }
            this.sessions.delete(sessionId);
        }
    }
    // ======================================================================
    // Private
    // ======================================================================
    /** Apply a reverse patch using `git apply --reverse`. */
    applyReverseGit(absPath, workspaceRoot, patchText) {
        if (!fs.existsSync(absPath))
            return false;
        const tmpPatch = path.join(workspaceRoot, '.claude', 'cc-diff', '.tmp-reverse.patch');
        try {
            const dir = path.dirname(tmpPatch);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(tmpPatch, patchText, 'utf8');
            (0, child_process_1.execSync)(`git apply --reverse --verbose "${tmpPatch}"`, {
                cwd: workspaceRoot,
                stdio: 'pipe',
                timeout: 5000,
                windowsHide: true,
            });
            return true;
        }
        catch {
            return false;
        }
        finally {
            try {
                fs.unlinkSync(tmpPatch);
            }
            catch { /* ignore */ }
        }
    }
    /**
     * Build a reverse (new->old) patch from the selected hunks.
     * For each hunk, swaps the old/new coordinates and flips +/- lines.
     */
    buildReversePatch(_entry, hunks) {
        const forwardPatch = hunks.map(h => h.patch).join('');
        const parsed = (0, diff_1.parsePatch)(forwardPatch);
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
    flipHunkLines(lines) {
        return lines.map(line => {
            if (line.startsWith('+'))
                return '-' + line.slice(1);
            if (line.startsWith('-'))
                return '+' + line.slice(1);
            return line;
        });
    }
    /** Serialize a ParsedDiff back to unified diff text. */
    formatDiff(diff) {
        let output = '';
        output += `--- ${diff.oldFileName}\n`;
        output += `+++ ${diff.newFileName}\n`;
        for (const hunk of diff.hunks) {
            output += `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n`;
            output += hunk.lines.map((l) => (l.endsWith('\n') ? l : l + '\n')).join('');
        }
        return output;
    }
    /** Update file status based on accepted/denied hunk counts. */
    syncFileStatus(entry) {
        const total = entry.hunks.length;
        const processed = entry.acceptedHunks.size + entry.deniedHunks.size;
        if (processed === 0) {
            entry.status = 'pending';
        }
        else if (processed === total) {
            entry.status = entry.deniedHunks.size > 0 ? 'denied' : 'accepted';
        }
        else {
            entry.status = 'partial';
        }
    }
}
exports.DiffManager = DiffManager;
//# sourceMappingURL=DiffManager.js.map