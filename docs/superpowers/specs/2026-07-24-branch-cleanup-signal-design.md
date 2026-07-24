# Branch Cleanup Signal — Design

**Date:** 2026-07-24
**Status:** approved

## Motivation

When a user switches git branches during a Claude Code session, the snapshots saved by `pre-tool-use.js` belong to the old branch. These stale snapshots are meaningless for the new branch and should be cleaned up.

Currently, branch-mismatch detection only happens when the cc-diff sidebar webview becomes visible (`WebviewProvider.checkBranchMismatch()`). This is too late — the user should be prompted proactively when the mismatch is first detected (i.e., when a snapshot is saved on a different branch).

## Design

### Signal file approach

`pre-tool-use.js` cannot show VSCode dialogs directly (it's a Node.js CLI hook). Instead, it writes a signal file to `.claude/cc-diff/branch-cleanup`. The VSCode extension watches for this signal and shows a non-modal confirmation dialog.

### Data flow

```
Claude Code edits a file
  │
  ▼
pre-tool-use.js
  ├─ Save snapshot (existing logic)
  ├─ Read index.json, compare branch of all entries vs current branch
  ├─ Any mismatch AND signal file doesn't exist?
  │    └─ Yes → Write .claude/cc-diff/branch-cleanup
  └─ No mismatch OR signal already exists → Skip
        │
        ▼ (VSCode FileSystemWatcher)
     extension.ts
        ├─ Read index.json → SnapshotManager.getMismatchedFiles()
        ├─ Show non-modal warning: "N snapshots from branch X, clean up?"
        ├─ User clicks "清理" → removeTrackedFile() for each
        ├─ User dismisses → do nothing
        └─ Delete branch-cleanup signal file
```

### Files changed

| File | Change |
|---|---|
| `hooks/pre-tool-use.js` | After saving snapshot, check for branch mismatches; write `branch-cleanup` signal if found |
| `src/extension.ts` | Add `FileSystemWatcher` for `branch-cleanup`; wire up `handleBranchCleanup()` |

### No changes needed

- `SnapshotManager.ts` — `getCurrentGitBranch()`, `getMismatchedFiles()`, `removeTrackedFile()` already exist
- `WebviewProvider.ts` — existing `checkBranchMismatch()` remains as a fallback when sidebar opens
- `hooks/session-end.js` — no changes

### Dedup guard

- pre-tool skips writing if `branch-cleanup` already exists
- Extension deletes `branch-cleanup` after processing (whether user confirms or not)
- This prevents repeated popups for the same mismatch

### Dialog choice

- **Non-modal** (`showWarningMessage` without `{ modal: true }`) — does not block the user's workflow
- Different from the existing `checkBranchMismatch()` which uses modal (that one fires when user explicitly opens the sidebar, so blocking is acceptable)
