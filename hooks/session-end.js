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
      let fileExists = true;
      try {
        currentContent = fs.readFileSync(absPath, 'utf8');
      } catch (e) {
        fileExists = false;
      }

      // If file was deleted, always keep the entry (user should review)
      // If content is identical, the edit was reverted — remove entry
      if (fileExists && snapshotContent === currentContent) {
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
