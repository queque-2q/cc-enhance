#!/usr/bin/env node
/**
 * cc-diff SessionEnd Hook
 *
 * Reads all snapshots from the completed session, computes diffs against
 * current file contents, and writes structured patch files for the extension.
 *
 * stdin:  { hook_event_name, session_id, cwd }
 * stdout: (none — writes files)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { createPatch } = require('diff');

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

/**
 * Recursively find all .snap files under a directory.
 */
function findSnapFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findSnapFiles(fullPath));
    } else if (entry.name.endsWith('.snap')) {
      results.push(fullPath);
    }
  }
  return results;
}

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

async function main() {
  try {
    const event = await readStdin();
    const { session_id, cwd } = event;

    // Use posix path methods because cwd is in POSIX format from Claude Code
    const pp = path.posix;
    const snapDir = pp.join(cwd, '.claude', 'cc-diff', 'snapshots', session_id);
    if (!fs.existsSync(snapDir)) {
      process.exit(0);
    }

    const patchesDir = pp.join(cwd, '.claude', 'cc-diff', 'patches', session_id);
    const fileList = [];

    const snapFiles = findSnapFiles(snapDir);

    for (const snapFile of snapFiles) {
      // Derive the relative file path from the snap path
      const relativeSnap = pp.relative(snapDir, snapFile);
      const relativeFile = relativeSnap.replace(/\.snap$/, '');

      // Read snapshot (old content before edits)
      const oldContent = fs.readFileSync(snapFile, 'utf8');

      // Read current file (new content after edits)
      const absFile = pp.join(cwd, relativeFile);
      let newContent = '';
      try {
        newContent = fs.readFileSync(absFile, 'utf8');
      } catch (e) {
        // File was deleted during the session
      }

      // Skip if no changes
      if (oldContent === newContent) {
        continue;
      }

      // Generate unified diff going from OLD→NEW
      const patch = createPatch(relativeFile, oldContent, newContent);

      // Parse into individual hunks
      const hunks = parseHunks(patch);

      if (hunks.length === 0) {
        continue;
      }

      // Write patch JSON file
      const patchJsonPath = pp.join(patchesDir, relativeFile + '.patch.json');
      fs.mkdirSync(pp.dirname(patchJsonPath), { recursive: true });
      fs.writeFileSync(patchJsonPath, JSON.stringify({
        file: relativeFile,
        hunks
      }, null, 2), 'utf8');

      fileList.push(relativeFile);
    }

    // Write session.json signal file (this is what the extension watches for)
    if (fileList.length > 0) {
      fs.mkdirSync(patchesDir, { recursive: true });
      fs.writeFileSync(pp.join(patchesDir, 'session.json'), JSON.stringify({
        sessionId: session_id,
        timestamp: Date.now(),
        files: fileList
      }, null, 2), 'utf8');
    }

    // Clean up snapshots
    fs.rmSync(snapDir, { recursive: true, force: true });
  } catch (err) {
    console.error('[cc-diff session-end]', err.message);
  }
  process.exit(0);
}

main();
