#!/usr/bin/env node
/**
 * cc-diff PreToolUse Hook
 *
 * Saves a snapshot of file content before Claude Code edits it.
 * Matches: Write | Edit | MultiEdit | NotebookEdit
 *
 * stdin:  { hook_event_name, tool_name, tool_input, session_id, cwd }
 * stdout: { systemMessage: "..." }
 */

'use strict';

const fs = require('fs');
const path = require('path');

/** Normalize any path to POSIX (forward slashes) for cross-platform storage. */
const toPosix = (p) => p.replace(/\\/g, '/');

/**
 * Script is at <workspace>/.claude/cc-diff/hooks/pre-tool-use.js
 * Derive cc-diff root and workspace root from script location.
 */
function getDirs() {
  const ccDiffRoot = path.dirname(__dirname);
  const workspaceRoot = path.dirname(path.dirname(ccDiffRoot));
  return { ccDiffRoot, workspaceRoot };
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

async function main() {
  try {
    const event = await readStdin();
    const { tool_input, session_id, cwd } = event;

    const filePath = getFilePath(tool_input);
    if (!filePath) {
      console.log(JSON.stringify({ systemMessage: 'no file path, skipping' }));
      process.exit(0);
    }

    // Derive paths from the script's own location
    const { workspaceRoot } = getDirs();

    // Resolve absolute path using platform-native path
    const absPath = path.resolve(workspaceRoot, filePath);

    // Compute relative path (POSIX for cross-platform key consistency)
    const posixRoot = toPosix(workspaceRoot);
    const posixAbsPath = toPosix(absPath);
    let relativePath = path.posix.relative(posixRoot, posixAbsPath);
    if (relativePath.startsWith('..')) {
      relativePath = path.posix.basename(posixAbsPath);
    }

    // Build snapshot path using platform-native path.join
    const snapDir = path.join(workspaceRoot, '.claude', 'cc-diff', 'snapshots', session_id);
    const snapFileDir = path.join(snapDir, path.dirname(relativePath));
    fs.mkdirSync(snapFileDir, { recursive: true });

    // Read current file content (empty string if file doesn't exist yet)
    let content = '';
    try {
      content = fs.readFileSync(absPath, 'utf8');
    } catch (e) {
      // File doesn't exist — this is a new file being created
    }

    // Write snapshot — store using the POSIX relative path as filename
    const snapPath = path.join(snapDir, relativePath + '.snap');
    fs.writeFileSync(snapPath, content, 'utf8');

    console.log(JSON.stringify({ systemMessage: 'snapshot saved' }));
  } catch (err) {
    console.error('[cc-diff pre-tool-use]', err.message);
  }
  process.exit(0);
}

main();
