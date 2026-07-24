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
const child_process = require('child_process');

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

    // Get current git branch — use the file's directory so git can
    // find .git in a parent directory even when workspaceRoot is not a repo.
    let branch = null;
    try {
      const fileDir = path.dirname(absPath);
      branch = child_process.execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: fileDir,
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 5000,
        windowsHide: true,
      }).trim();
    } catch {
      // File is not in a git repo — no branch info
    }

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
      const newEntry = {
        file: relativePath,
        snapshotFile: safeFile + '.snap',
        sessionId: session_id,
        timestamp: Date.now(),
        status: 'pending',
      };
      if (branch) {
        newEntry.branch = branch;
      }
      index.files.push(newEntry);
      writeIndex(indexPath, index);
    }

    console.log(JSON.stringify({ systemMessage: 'snapshot saved' }));

    // ── Branch mismatch check ──────────────────────────────────────
    // After saving, check if any existing snapshots belong to a different
    // branch. If so, write a signal file so the VSCode extension can
    // prompt the user to clean up stale snapshots.
    if (branch) {
      const mismatched = index.files.filter(f => f.branch && f.branch !== branch);
      if (mismatched.length > 0) {
        const cleanupSignalPath = path.join(ccDiffRoot, 'branch-cleanup');
        if (!fs.existsSync(cleanupSignalPath)) {
          const signalData = {
            currentBranch: branch,
            mismatchedBranches: [...new Set(mismatched.map(f => f.branch).filter(Boolean))],
            mismatchedCount: mismatched.length,
            timestamp: Date.now(),
          };
          try {
            fs.writeFileSync(cleanupSignalPath, JSON.stringify(signalData, null, 2), 'utf8');
          } catch {}
        }
      }
    }
  } catch (err) {
    console.error('[cc-diff pre-tool-use]', err.message);
  }
  process.exit(0);
}

main();
