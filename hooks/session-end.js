#!/usr/bin/env node
/**
 * cc-diff SessionEnd Hook
 *
 * Reads all snapshots from the completed session, computes diffs against
 * current file contents using git diff, and writes structured patch files
 * for the extension.
 *
 * Patches are stored flat (not nested by session) with timestamp-prefixed
 * filenames so the extension can process them in correct chronological
 * order for reverse-apply.
 *
 * stdin:  { hook_event_name, session_id, cwd }
 * stdout: (none — writes files)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// ==========================================================================
// Helpers
// ==========================================================================

/** Normalize any path to POSIX (forward slashes). */
const toPosix = (p) => p.replace(/\\/g, '/');

/**
 * Derive the cc-diff root from the script's own location.
 * Script lives at <workspace>/.claude/cc-diff/hooks/session-end.js
 * So .claude/cc-diff/ is the parent directory.
 */
function getCcDiffRoot() {
  return path.dirname(__dirname);
}

/**
 * Convert a POSIX file path into a safe filename component.
 * Replaces path separators and colons with dashes.
 * "src/DiffManager.ts" → "src-DiffManager.ts"
 */
function toSafeFileName(relativeFile) {
  return relativeFile.replace(/[/\\:]/g, '-');
}

// ==========================================================================
// Debug log (writes to %TEMP%/cc-diff-debug/session-end.log)
// ==========================================================================

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

// ==========================================================================
// Snapshot file discovery
// ==========================================================================

/**
 * Recursively find all .snap files under a directory.
 * Uses platform-native `path` so fs operations work reliably on Windows.
 */
function findSnapFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findSnapFiles(fullPath));
    } else if (entry.name.endsWith('.snap')) {
      results.push(fullPath);
    }
  }
  return results;
}

// ==========================================================================
// Diff generation
// ==========================================================================

/**
 * Generate a unified diff using `git diff --no-index`.
 *
 * Instead of trying to regex-replace absolute temp paths (fragile on Windows
 * due to drive letters, slashes, short names), we reconstruct the diff header
 * ourselves from the known old/new content and relative path.
 *
 * Returns the complete unified diff text, or empty string on failure.
 */
function gitDiff(oldContent, newContent, relativeFile) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-diff-'));
  try {
    const oldTmp = path.join(tmpDir, 'a', relativeFile);
    const newTmp = path.join(tmpDir, 'b', relativeFile);

    fs.mkdirSync(path.dirname(oldTmp), { recursive: true });
    fs.mkdirSync(path.dirname(newTmp), { recursive: true });
    fs.writeFileSync(oldTmp, oldContent, 'utf8');
    fs.writeFileSync(newTmp, newContent, 'utf8');

    // git diff --no-index at the tmpDir root → relative paths are a/<file> and b/<file>
    let stdout;
    try {
      stdout = execSync(
        `git diff --no-index --no-color -U2 "a/${relativeFile}" "b/${relativeFile}"`,
        { encoding: 'utf8', stdio: 'pipe', timeout: 10000, cwd: tmpDir, windowsHide: true }
      );
    } catch (e) {
      // git diff exits with code 1 when there are differences (normal case)
      if (e.status === 1 && e.stdout) {
        stdout = typeof e.stdout === 'string' ? e.stdout : e.stdout.toString();
      } else {
        const stderr = e.stderr ? (typeof e.stderr === 'string' ? e.stderr : e.stderr.toString()) : '';
        debugLog(`gitDiff FAILED for "${relativeFile}": status=${e.status} stderr="${stderr.trim()}"`);
        return '';
      }
    }

    if (!stdout) return '';

    // The git diff output already has correct relative paths in the headers
    // (e.g. --- a/src/file.ts\n+++ b/src/file.ts) because we placed the files
    // at a/<relativeFile> and b/<relativeFile> inside tmpDir.
    // No regex replacement needed — much more reliable on Windows.
    return stdout;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Fallback: simple line-by-line diff when git is unavailable.
 * Produces a minimal unified-diff-like output.
 */
function simpleDiff(oldContent, newContent, relativeFile) {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  // If content is identical, no diff
  if (oldContent === newContent) return '';

  // Build a minimal unified diff
  const maxLen = Math.max(oldLines.length, newLines.length);
  const lines = [];
  lines.push(`--- a/${relativeFile}`);
  lines.push(`+++ b/${relativeFile}`);
  lines.push(`@@ -1,${oldLines.length} +1,${newLines.length} @@`);

  // Simple LCS-based approach would be better, but for a fallback,
  // show old lines as removed and new lines as added
  for (let i = 0; i < maxLen; i++) {
    const oldLine = i < oldLines.length ? oldLines[i] : null;
    const newLine = i < newLines.length ? newLines[i] : null;
    if (oldLine === newLine) {
      lines.push(` ${oldLine}`);
    } else {
      if (oldLine !== null) lines.push(`-${oldLine}`);
      if (newLine !== null) lines.push(`+${newLine}`);
    }
  }
  return lines.join('\n');
}

// ==========================================================================
// Patch parsing
// ==========================================================================

/**
 * Parse a unified diff string into individual hunks.
 * Each hunk has: id, header (@@ line), patch (header + body lines).
 */
function parseHunks(patchText) {
  const hunks = [];
  const lines = patchText.split('\n');
  let currentHunk = null;
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
        patch: line + '\n'
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

// ==========================================================================
// Index file management (atomic read-modify-write)
// ==========================================================================

/**
 * Read the global patches index, or return an empty structure if it
 * doesn't exist or is corrupt.
 */
function readIndex(indexPath) {
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
  } catch (e) {
    debugLog(`readIndex: WARN — cannot parse ${indexPath}, starting fresh: ${e.message}`);
    return { version: 1, patches: [] };
  }
}

/**
 * Atomically write the index by writing to a temp file and renaming.
 * This prevents corruption from concurrent writes.
 */
function writeIndex(indexPath, indexData) {
  const tmpPath = indexPath + '.tmp-' + Date.now();
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(indexData, null, 2), 'utf8');
    fs.renameSync(tmpPath, indexPath);
  } catch (e) {
    debugLog(`writeIndex: ERROR — ${e.message}`);
    // Best-effort cleanup of temp file
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

// ==========================================================================
// Main
// ==========================================================================

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
    debugLog(`RAW STDIN (first 2000 chars): ${stdinRaw.substring(0, 2000)}`);

    const event = JSON.parse(stdinRaw);
    const { session_id, cwd } = event;

    // Derive paths from the script's own location.
    // Script is at <workspace>/.claude/cc-diff/hooks/session-end.js
    // ccDiffRoot = <workspace>/.claude/cc-diff
    const ccDiffRoot = getCcDiffRoot();
    // workspaceRoot = <workspace> (two levels up from cc-diff)
    const workspaceRoot = path.dirname(path.dirname(ccDiffRoot));
    debugLog(`session_id=${session_id} cwd="${cwd}" ccDiffRoot="${ccDiffRoot}" workspaceRoot="${workspaceRoot}"`);

    // --- Locate snapshots ---
    const snapDir = path.join(ccDiffRoot, 'snapshots', session_id);
    debugLog(`snapDir=${snapDir} exists=${fs.existsSync(snapDir)}`);

    if (!fs.existsSync(snapDir)) {
      debugLog(`ccDiffRoot contents: ${fs.existsSync(ccDiffRoot) ? fs.readdirSync(ccDiffRoot).join(', ') : 'MISSING'}`);
      const snapBase = path.join(ccDiffRoot, 'snapshots');
      if (fs.existsSync(snapBase)) {
        debugLog(`Available sessions: ${fs.readdirSync(snapBase).join(', ')}`);
      }
      debugLog('EXIT: snapDir not found — no snapshots to process');
      process.exit(0);
    }

    // --- Find all snapshots ---
    const snapFiles = findSnapFiles(snapDir);
    debugLog(`Found ${snapFiles.length} snap file(s)`);

    if (snapFiles.length === 0) {
      debugLog('EXIT: no .snap files found');
      process.exit(0);
    }

    // --- Read existing index ---
    const patchesDir = path.join(ccDiffRoot, 'patches');
    fs.mkdirSync(patchesDir, { recursive: true });
    const indexPath = path.join(patchesDir, 'index.json');
    const index = readIndex(indexPath);

    // Track which patch IDs already exist (dedup by id)
    const existingIds = new Set(index.patches.map(p => p.id));

    // --- Timestamp for this batch ---
    const batchTimestamp = Date.now();

    // --- Process each snapshot ---
    const newEntries = [];

    for (const snapFile of snapFiles) {
      const relativeSnap = path.relative(snapDir, snapFile);
      const relativeFilePosix = toPosix(relativeSnap.replace(/\.snap$/, ''));
      debugLog(`Processing: ${relativeFilePosix}`);

      // Read snapshot (old content)
      let oldContent;
      try {
        oldContent = fs.readFileSync(snapFile, 'utf8');
      } catch (e) {
        debugLog(`  SKIP: cannot read snapshot: ${e.message}`);
        continue;
      }

      // Read current file from workspace root
      const absFile = path.resolve(workspaceRoot, relativeFilePosix);
      let newContent = '';
      try {
        newContent = fs.readFileSync(absFile, 'utf8');
      } catch (e) {
        debugLog(`  NOTE: current file not found at "${absFile}" (may have been deleted)`);
      }

      // Skip if no content change
      if (oldContent === newContent) {
        debugLog(`  SKIP: no changes (old === new, ${oldContent.length} chars)`);
        continue;
      }

      // Generate unified diff
      let patch = gitDiff(oldContent, newContent, relativeFilePosix);
      if (!patch) {
        // git diff failed — try simple fallback
        debugLog(`  WARN: git diff failed for "${relativeFilePosix}", trying fallback`);
        patch = simpleDiff(oldContent, newContent, relativeFilePosix);
      }
      if (!patch) {
        debugLog(`  SKIP: no diff output generated`);
        continue;
      }

      // Parse into hunks
      const hunks = parseHunks(patch);
      if (hunks.length === 0) {
        debugLog(`  SKIP: no hunks parsed from diff (${patch.length} chars)`);
        continue;
      }
      debugLog(`  OK: ${hunks.length} hunk(s) parsed`);

      // Build flat filename: <timestamp>-<sessionId>-<safeFile>.patch.json
      const safeFile = toSafeFileName(relativeFilePosix);
      const patchFileName = `${batchTimestamp}-${session_id}-${safeFile}.patch.json`;
      const patchId = patchFileName.replace(/\.patch\.json$/, '');

      // Skip if this exact patch already exists in the index
      if (existingIds.has(patchId)) {
        debugLog(`  SKIP: patch already in index — ${patchId}`);
        continue;
      }

      // Write patch JSON (flat — directly in patches/)
      const patchJsonPath = path.join(patchesDir, patchFileName);
      fs.writeFileSync(patchJsonPath, JSON.stringify({
        file: relativeFilePosix,
        hunks
      }, null, 2), 'utf8');

      // Build index entry
      newEntries.push({
        id: patchId,
        sessionId: session_id,
        timestamp: batchTimestamp,
        file: relativeFilePosix,
        patchFile: patchFileName,
      });

      debugLog(`  WROTE: ${patchFileName}`);
    }

    // --- Update index.json (atomic) ---
    if (newEntries.length > 0) {
      // Append new entries and sort by timestamp ascending
      index.patches.push(...newEntries);
      index.patches.sort((a, b) => a.timestamp - b.timestamp);
      writeIndex(indexPath, index);
      debugLog(`DONE: added ${newEntries.length} patch(es) to index — total: ${index.patches.length}`);
    } else {
      debugLog('DONE: no new patches to add');
    }

    // Clean up snapshots after generating patches — they are no longer needed
    try {
      fs.rmSync(snapDir, { recursive: true, force: true });
      debugLog(`CLEANUP: removed snapshots directory ${snapDir}`);
    } catch (e) {
      debugLog(`CLEANUP: failed to remove snapshots: ${e.message}`);
    }

  } catch (err) {
    debugLog(`FATAL: ${err.message}\n${err.stack || ''}`);
    console.error('[cc-diff session-end]', err.message);
  }
  process.exit(0);
}

main();
