#!/usr/bin/env node
/**
 * stdin:  { hook_event_name, tool_name, tool_input, session_id, cwd } cc-diff PostToolUse Hook (v4)
 *
 * stdin:  { hook_event_name, tool_name, tool_input, session_id, cwd }
 * Removes the entry if content was reverted (no diff).
 * No longer computes or stores diffs.
 *
 * stdin:  { hook_event_name, tool_name, tool_input, session_id, cwd }
 * stdout: (none — writes index.json)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Helpers ────────────────────────────────────────────────────────

const toPosix = (p) => p.replace(/\\/g, '/');

/**
 * Script is at <workspace>/.claude/cc-diff/hooks/post-tool-use.js
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
      path.join(debugLogDir, 'post-tool-use.log'),
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

    debugLog(`session_id=${session_id} file="${relativePath}"`);
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

function getFilePath(toolInput) {
  return toolInput.file_path || toolInput.notebook_path || null;
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
    let tool_input = {};
    try {
      const event = JSON.parse(stdinRaw);
      session_id = event.session_id || 'unknown';
      tool_input = event.tool_input || {};
    } catch {}

    const filePath = getFilePath(tool_input);
    if (!filePath) {
      debugLog('EXIT: no file_path in tool_input');
      process.exit(0);
    }

    const ccDiffRoot = getCcDiffRoot();
    const workspaceRoot = path.dirname(path.dirname(ccDiffRoot));

    // Compute POSIX relative path (same logic as pre-tool-use.js)
    const absPath = path.resolve(workspaceRoot, filePath);
    const posixRoot = toPosix(workspaceRoot);

    const posixAbsPath = toPosix(absPath);

    if (relativePath.startsWith('..')) {
    if (relativePath.startsWith('..')) {

    }

    debugLog(`session_id=${session_id} file="${relativePath}"`);

    // --- Read index.json ---
    const indexPath = path.join(ccDiffRoot, 'index.json');
    const index = readIndex(indexPath);

    if (index.version !== 2 || index.files.length === 0) {
      debugLog('EXIT: no v2 tracked files');
      process.exit(0);
    }

    // --- Find the entry for this file ---
    const entry = index.files.find(f => f.file === relativePath);
    if (!entry) {
      debugLog(`EXIT: "${relativePath}" not tracked`);
      process.exit(0);
    }

    const snapshotsDir = path.join(ccDiffRoot, 'snapshots');
    const snapPath = path.join(snapshotsDir, entry.snapshotFile);

    // Read snapshot
    let snapshotContent = '';
    try {
      snapshotContent = fs.readFileSync(snapPath, 'utf8');
    } catch (e) {
      debugLog(`  REMOVE: "${entry.file}" — snapshot file missing`);
      index.files = index.files.filter(f => f.file !== relativePath);
      writeIndex(indexPath, index);
      process.exit(0);
    }

    // Read current workspace file
    let currentContent = '';
    let fileExists = true;
    try {
      currentContent = fs.readFileSync(absPath, 'utf8');
    } catch (e) {
      fileExists = false;
    }

    // If content is identical, the edit was reverted — remove entry
    if (fileExists && snapshotContent === currentContent) {
      debugLog(`  REMOVE: "${entry.file}" — no changes (reverted)`);
      try { fs.unlinkSync(snapPath); } catch {}
      index.files = index.files.filter(f => f.file !== relativePath);
      writeIndex(indexPath, index);
      process.exit(0);
    }

    // Has changes — update timestamp
    entry.timestamp = Date.now();
    entry.status = entry.status || 'pending';
    writeIndex(indexPath, index);
    debugLog(`  KEEP: "${entry.file}" — changes detected`);

  } catch (err) {
    debugLog(`FATAL: ${err.message}\n${err.stack || ''}`);
    console.error('[cc-diff post-tool-use]', err.message);
  }
  process.exit(0);
}

main();
