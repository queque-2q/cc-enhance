#!/usr/bin/env bash
# cc-diff integration test (v4 — snapshot model)
# Simulates a Claude Code session from hook triggering to diff display.
set -e

TEST_DIR="F:/tmp/cc-diff-integration-$$"
REPO_HOOKS_DIR="$(cd "$(dirname "$0")/../hooks" && pwd)"

echo "=== cc-diff Integration Test (v4) ==="
echo "Test directory: $TEST_DIR"

# Setup
rm -rf "$TEST_DIR"
mkdir -p "$TEST_DIR"
cd "$TEST_DIR"
git init
git config user.email "test@test.com"
git config user.name "Test"

# Deploy hooks to mimic the runtime structure:
#   <workspace>/.claude/cc-diff/hooks/<hook>.js
# The hooks use __dirname to derive ccDiffRoot and workspaceRoot,
# so they must be at the correct path for the test to work.
mkdir -p "$TEST_DIR/.claude/cc-diff/hooks"
cp "$REPO_HOOKS_DIR/pre-tool-use.js" "$TEST_DIR/.claude/cc-diff/hooks/"
cp "$REPO_HOOKS_DIR/session-end.js" "$TEST_DIR/.claude/cc-diff/hooks/"
HOOKS_DIR="$TEST_DIR/.claude/cc-diff/hooks"

# Create initial file
echo "line 1
line 2
line 3" > hello.txt
git add hello.txt && git commit -m "initial"

# --- Step 1: PreToolUse hook captures snapshot ---
echo ""
echo "--- Step 1: PreToolUse hook captures snapshot ---"
echo '{"hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"hello.txt","content":"new"},"session_id":"test-s1","cwd":"'"$TEST_DIR"'"}' | node "$HOOKS_DIR/pre-tool-use.js"
echo "Exit: $?"
echo "Snapshot:"
ls -la "$TEST_DIR/.claude/cc-diff/snapshots/hello.txt.snap"
echo "Content:"
cat "$TEST_DIR/.claude/cc-diff/snapshots/hello.txt.snap"

# --- Step 2: Simulate Claude Code editing the file ---
echo ""
echo "--- Step 2: Simulate Claude Code editing hello.txt ---"
echo "line 1
line 2 modified
line 3
line 4 added" > hello.txt
echo "Current hello.txt:"
cat hello.txt

# --- Step 3: SessionEnd hook verifies changes ---
echo ""
echo "--- Step 3: Stop hook verifies changes ---"
echo '{"hook_event_name":"Stop","session_id":"test-s1","cwd":"'"$TEST_DIR"'"}' | node "$HOOKS_DIR/session-end.js"
echo "SessionEnd exit: $?"

# --- Step 4: Verify index.json v2 ---
echo ""
echo "--- Step 4: Verify index.json v2 ---"
INDEX_PATH="$TEST_DIR/.claude/cc-diff/index.json"

echo "index.json:"
cat "$INDEX_PATH"
echo ""

# Verify version
if ! grep -q '"version": 2' "$INDEX_PATH"; then
  echo "FAIL: index.json version is not 2"
  exit 1
fi

# Verify file entry
if ! grep -q '"file": "hello.txt"' "$INDEX_PATH"; then
  echo "FAIL: index.json missing file entry"
  exit 1
fi

# Verify snapshot file reference
if ! grep -q '"snapshotFile": "hello.txt.snap"' "$INDEX_PATH"; then
  echo "FAIL: index.json missing snapshotFile"
  exit 1
fi

# Verify status
if ! grep -q '"status": "pending"' "$INDEX_PATH"; then
  echo "FAIL: index.json missing pending status"
  exit 1
fi

echo "PASS: index.json v2 structure validated"

# --- Step 5: Verify snapshot still exists (not deleted by session-end) ---
echo ""
echo "--- Step 5: Verify snapshot preserved ---"
if [ -f "$TEST_DIR/.claude/cc-diff/snapshots/hello.txt.snap" ]; then
  echo "PASS: snapshot preserved after session-end"
else
  echo "FAIL: snapshot was deleted"
  exit 1
fi

# --- Step 6: Test snapshot idempotency ---
echo ""
echo "--- Step 6: Test PreToolUse idempotency ---"
echo '{"hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"hello.txt","content":"new"},"session_id":"test-s2","cwd":"'"$TEST_DIR"'"}' | node "$HOOKS_DIR/pre-tool-use.js"
echo "Exit: $?"
# Snapshot should still have ORIGINAL content (not modified)
SNAP_CONTENT=$(cat "$TEST_DIR/.claude/cc-diff/snapshots/hello.txt.snap")
if [ "$SNAP_CONTENT" = "line 1
line 2
line 3" ]; then
  echo "PASS: snapshot unchanged (correct)"
else
  echo "FAIL: snapshot was overwritten: $SNAP_CONTENT"
  exit 1
fi

# --- Step 7: Test session-end cleanup when file reverted ---
echo ""
echo "--- Step 7: Test cleanup when file is reverted ---"
# Revert hello.txt to original content
echo "line 1
line 2
line 3" > hello.txt
echo '{"hook_event_name":"Stop","session_id":"test-s3","cwd":"'"$TEST_DIR"'"}' | node "$HOOKS_DIR/session-end.js"
echo "Exit: $?"
# Check that index.json was cleaned up
if [ -f "$INDEX_PATH" ]; then
  echo "index.json still exists. Content:"
  cat "$INDEX_PATH"
  # Should have 0 files or not exist
  if grep -q 'hello.txt' "$INDEX_PATH"; then
    echo "FAIL: hello.txt still in index after revert"
    exit 1
  else
    echo "PASS: hello.txt removed from index"
  fi
else
  echo "PASS: index.json deleted (no remaining files)"
fi

# --- Step 8: Test new file creation ---
echo ""
echo "--- Step 8: Test new file creation ---"
echo '{"hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"newfile.txt"},"session_id":"test-s4","cwd":"'"$TEST_DIR"'"}' | node "$HOOKS_DIR/pre-tool-use.js"
echo "Exit: $?"
if [ -f "$TEST_DIR/.claude/cc-diff/snapshots/newfile.txt.snap" ]; then
  echo "PASS: new file snapshot created"
  SNAP_CONTENT=$(cat "$TEST_DIR/.claude/cc-diff/snapshots/newfile.txt.snap")
  if [ -z "$SNAP_CONTENT" ]; then
    echo "PASS: new file snapshot is empty (correct)"
  else
    echo "FAIL: new file snapshot should be empty, got: $SNAP_CONTENT"
    exit 1
  fi
else
  echo "FAIL: new file snapshot not created"
  exit 1
fi

echo ""
echo "=== Integration test PASSED ==="
