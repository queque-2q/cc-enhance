#!/usr/bin/env bash
# cc-diff integration test
# Simulates a Claude Code session from hook triggering to diff display.
set -e

# Use Windows-compatible temp path (Node.js fs on Windows resolves /tmp as C:\tmp,
# which differs from Git Bash's /tmp mapping)
TEST_DIR="F:/tmp/cc-diff-integration-$$"
HOOKS_DIR="$(cd "$(dirname "$0")/../hooks" && pwd)"

echo "=== cc-diff Integration Test ==="
echo "Test directory: $TEST_DIR"

# Setup
rm -rf "$TEST_DIR"
mkdir -p "$TEST_DIR"
cd "$TEST_DIR"
git init
git config user.email "test@test.com"
git config user.name "Test"

# Create initial file
echo "line 1
line 2
line 3" > hello.txt
git add hello.txt && git commit -m "initial"

# --- Simulate PreToolUse hook ---
echo ""
echo "--- Step 1: PreToolUse hook captures snapshot ---"
echo '{"hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"hello.txt","content":"new"},"session_id":"test-s1","cwd":"'"$TEST_DIR"'"}' | node "$HOOKS_DIR/pre-tool-use.js"
echo "Exit: $?"
ls -la "$TEST_DIR/.claude/cc-diff/snapshots/test-s1/hello.txt.snap"

# --- Simulate Claude Code editing the file ---
echo ""
echo "--- Step 2: Simulate Claude Code editing hello.txt ---"
echo "line 1
line 2 modified
line 3
line 4 added" > hello.txt
echo "Current hello.txt:"
cat hello.txt

# --- Simulate SessionEnd hook ---
echo ""
echo "--- Step 3: SessionEnd hook computes diffs ---"
echo '{"hook_event_name":"Stop","session_id":"test-s1","cwd":"'"$TEST_DIR"'"}' | node "$HOOKS_DIR/session-end.js"
echo "SessionEnd exit: $?"

# --- Verify outputs ---
echo ""
echo "--- Step 4: Verify flat patch outputs ---"
PATCHES_DIR="$TEST_DIR/.claude/cc-diff/patches"

echo "index.json:"
cat "$PATCHES_DIR/index.json"
echo ""

# Find the patch file (dynamic timestamp-sessionId-safeFile name)
PATCH_FILE=$(ls "$PATCHES_DIR"/*-test-s1-hello.txt.patch.json 2>/dev/null | head -1)
if [ -z "$PATCH_FILE" ]; then
  echo "FAIL: patch file not found!"
  echo "Directory listing:"
  ls -la "$PATCHES_DIR/"
  exit 1
fi
echo "Patch file: $(basename "$PATCH_FILE")"
cat "$PATCH_FILE"

# --- Verify snapshots cleaned up ---
echo ""
echo "--- Step 5: Verify snapshots cleaned up ---"
if [ -d "$TEST_DIR/.claude/cc-diff/snapshots/test-s1" ]; then
  echo "FAIL: snapshots directory still exists!"
  exit 1
else
  echo "PASS: snapshots cleaned up"
fi

# --- Verify patch contains expected changes ---
echo ""
echo "--- Step 6: Verify patch content ---"
if ! grep -q "line 2 modified" "$PATCH_FILE"; then
  echo "FAIL: patch doesn't contain expected change"
  exit 1
fi
if ! grep -q "line 4 added" "$PATCH_FILE"; then
  echo "FAIL: patch doesn't contain expected addition"
  exit 1
fi
echo "PASS: patch contains expected changes"

# --- Verify index.json entries ---
echo ""
echo "--- Step 7: Verify index.json structure ---"
if ! grep -q '"version"' "$PATCHES_DIR/index.json"; then
  echo "FAIL: index.json missing version"
  exit 1
fi
if ! grep -q '"file": "hello.txt"' "$PATCHES_DIR/index.json"; then
  echo "FAIL: index.json missing file entry"
  exit 1
fi
if ! grep -q '"sessionId": "test-s1"' "$PATCHES_DIR/index.json"; then
  echo "FAIL: index.json missing sessionId"
  exit 1
fi
echo "PASS: index.json structure validated"

echo ""
echo "=== Integration test PASSED ==="
