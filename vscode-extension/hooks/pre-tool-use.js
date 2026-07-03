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
  // Write and Edit use file_path; NotebookEdit uses notebook_path
  return toolInput.file_path || toolInput.notebook_path || null;
}

async function main() {
  // Platform-native path for file resolution (handles drive letters on Windows).
  // path.posix for snapshot path construction (forward slashes cross-platform).
  const pp = path.posix;

  try {
    const event = await readStdin();
    const { tool_input, session_id, cwd } = event;

    const filePath = getFilePath(tool_input);
    if (!filePath) {
      console.log(JSON.stringify({ systemMessage: 'no file path, skipping' }));
      process.exit(0);
    }

    // Resolve absolute path using platform-native path (handles win32 drive letters)
    const absPath = path.resolve(cwd, filePath);

    // Normalize to forward slashes for posix operations
    const toPosix = (p) => p.replace(/\\/g, '/');
    const posixCwd = toPosix(cwd);
    const posixAbsPath = toPosix(absPath);

    // Compute relative path from workspace root
    let relativePath = pp.relative(posixCwd, posixAbsPath);
    // Guard against paths outside cwd (use basename as fallback)
    if (relativePath.startsWith('..')) {
      relativePath = pp.basename(posixAbsPath);
    }

    // Create snapshots directory
    const snapDir = pp.join(posixCwd, '.claude', 'cc-diff', 'snapshots', session_id);
    const snapFileDir = pp.dirname(pp.join(snapDir, relativePath));
    fs.mkdirSync(snapFileDir, { recursive: true });

    // Read current file content (empty string if file doesn't exist yet)
    let content = '';
    try {
      content = fs.readFileSync(absPath, 'utf8');
    } catch (e) {
      // File doesn't exist — this is a new file being created
    }

    // Write snapshot
    const snapPath = pp.join(snapDir, relativePath + '.snap');
    fs.writeFileSync(snapPath, content, 'utf8');

    console.log(JSON.stringify({ systemMessage: 'snapshot saved' }));
  } catch (err) {
    // Never block the editor — log and exit cleanly
    console.error('[cc-diff pre-tool-use]', err.message);
  }
  process.exit(0);
}

main();
