import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Manages deployment and auto-update of Claude Code hook scripts
 * from the extension's bundled hooks/ directory to the workspace's
 * .claude/cc-diff/hooks/ directory.
 */
export class HooksManager {
  private extensionPath: string;

  /** Version marker written to the hooks target directory for update checks. */
  private static readonly VERSION_MARKER = 'cc-diff-hooks-v1';

  constructor(extensionPath: string) {
    this.extensionPath = extensionPath;
  }

  // ------------------------------------------------------------------
  // Path helpers
  // ------------------------------------------------------------------

  /** The extension's bundled hooks source directory. */
  getSourceHooksDir(): string {
    return path.join(this.extensionPath, 'hooks');
  }

  /** The target hooks directory within the workspace. */
  getTargetHooksDir(workspaceRoot: string): string {
    return path.join(workspaceRoot, '.claude', 'cc-diff', 'hooks');
  }

  // ------------------------------------------------------------------
  // Auto-update on activation
  // ------------------------------------------------------------------

  /**
   * Called on extension activation. If hook scripts already exist in the
   * workspace, check whether they are outdated and silently update them.
   */
  async autoUpdate(workspaceRoot: string): Promise<void> {
    try {
      const targetDir = this.getTargetHooksDir(workspaceRoot);

      // If no hooks are installed yet, do nothing (user hasn't set up)
      if (!fs.existsSync(targetDir)) {
        return;
      }

      // Check version marker
      const markerPath = path.join(targetDir, '.version');
      if (fs.existsSync(markerPath)) {
        const installedVersion = fs.readFileSync(markerPath, 'utf8').trim();
        if (installedVersion === HooksManager.VERSION_MARKER) {
          return; // Already up to date
        }
      }

      // Update hooks
      await this.copyHooksToTarget(targetDir);
      this.writeVersionMarker(targetDir);
    } catch {
      // Auto-update is best-effort — never break activation
    }
  }

  // ------------------------------------------------------------------
  // Setup command
  // ------------------------------------------------------------------

  /**
   * Full hook setup: copy scripts, install dependencies, update settings.json.
   * Called by the `cc-diff.setupHooks` command.
   */
  async setupHooks(workspaceRoot: string): Promise<void> {
    const sourceDir = this.getSourceHooksDir();
    if (!fs.existsSync(sourceDir)) {
      throw new Error(`Hooks source directory not found: ${sourceDir}`);
    }

    const targetDir = this.getTargetHooksDir(workspaceRoot);

    // 1. Copy hook scripts
    await this.copyHooksToTarget(targetDir);

    // 2. Install diff dependency (copy from extension's node_modules)
    await this.copyDiffPackage(targetDir);

    // 3. Write version marker
    this.writeVersionMarker(targetDir);

    // 4. Update .claude/settings.json
    await this.updateClaudeSettings(workspaceRoot, targetDir);
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  /** Copy hook script files (*.js, package.json) from source to target. */
  private async copyHooksToTarget(targetDir: string): Promise<void> {
    const sourceDir = this.getSourceHooksDir();

    // Ensure target directory exists
    fs.mkdirSync(targetDir, { recursive: true });

    // Copy hook JS files
    const filesToCopy = ['pre-tool-use.js', 'session-end.js'];
    for (const file of filesToCopy) {
      const src = path.join(sourceDir, file);
      const dst = path.join(targetDir, file);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dst);
      }
    }

    // Copy package.json (needed if user wants to run npm install separately)
    const pkgSrc = path.join(sourceDir, 'package.json');
    const pkgDst = path.join(targetDir, 'package.json');
    if (fs.existsSync(pkgSrc)) {
      fs.copyFileSync(pkgSrc, pkgDst);
    }
  }

  /**
   * Copy the `diff` npm package from the extension's node_modules to the
   * target hooks directory so the hook scripts can `require('diff')`.
   */
  private async copyDiffPackage(targetDir: string): Promise<void> {
    // The extension has `diff` as a dependency at:
    //   <extensionPath>/node_modules/diff/
    const extDiffDir = path.join(this.extensionPath, 'node_modules', 'diff');
    if (!fs.existsSync(extDiffDir)) {
      // Fallback: try the project-level node_modules (dev scenario)
      const altDiffDir = path.join(this.extensionPath, '..', '..', 'node_modules', 'diff');
      if (fs.existsSync(altDiffDir)) {
        this.copyDirSync(altDiffDir, path.join(targetDir, 'node_modules', 'diff'));
        return;
      }
      throw new Error(
        '未找到 diff 依赖包，请先在扩展目录中运行 npm install'
      );
    }

    const targetDiffDir = path.join(targetDir, 'node_modules', 'diff');
    this.copyDirSync(extDiffDir, targetDiffDir);
  }

  /** Write a version marker file so auto-update can detect stale hooks. */
  private writeVersionMarker(targetDir: string): void {
    fs.writeFileSync(
      path.join(targetDir, '.version'),
      HooksManager.VERSION_MARKER,
      'utf8'
    );
  }

  /**
   * Merge the cc-diff hook configuration into the project's
   * .claude/settings.json. Preserves existing settings.
   */
  private async updateClaudeSettings(
    workspaceRoot: string,
    hooksDir: string
  ): Promise<void> {
    const claudeDir = path.join(workspaceRoot, '.claude');
    const settingsPath = path.join(claudeDir, 'settings.json');

    // Read existing settings or start fresh
    let settings: any = {};
    if (fs.existsSync(settingsPath)) {
      try {
        const raw = fs.readFileSync(settingsPath, 'utf8');
        settings = JSON.parse(raw);
      } catch {
        settings = {};
      }
    }

    // Build hook command paths (use forward slashes for cross-platform JSON)
    const posixHooksDir = hooksDir.replace(/\\/g, '/');
    const preToolUseCmd = `node ${posixHooksDir}/pre-tool-use.js`;
    const sessionEndCmd = `node ${posixHooksDir}/session-end.js`;

    // Ensure hooks container exists
    if (!settings.hooks) {
      settings.hooks = {};
    }

    // PreToolUse: add or update the cc-diff entry
    const preToolUseMatcher = 'Write|Edit|MultiEdit|NotebookEdit';
    if (!Array.isArray(settings.hooks.PreToolUse)) {
      settings.hooks.PreToolUse = [];
    }

    const existingPreTool = settings.hooks.PreToolUse.findIndex(
      (h: any) => h.matcher === preToolUseMatcher
    );

    const preToolUseEntry = {
      matcher: preToolUseMatcher,
      hooks: [
        {
          type: 'command',
          command: preToolUseCmd,
          timeout: 10000,
        },
      ],
    };

    if (existingPreTool >= 0) {
      settings.hooks.PreToolUse[existingPreTool] = preToolUseEntry;
    } else {
      settings.hooks.PreToolUse.push(preToolUseEntry);
    }

    // SessionEnd: add or update cc-diff entry (idempotent)
    const sessionEndEntry = {
      hooks: [
        {
          type: 'command',
          command: sessionEndCmd,
          timeout: 30000,
        },
      ],
    };

    if (!Array.isArray(settings.hooks.SessionEnd)) {
      settings.hooks.SessionEnd = [];
    }

    // Check if a cc-diff session-end hook already exists
    const existingSessionEnd = settings.hooks.SessionEnd.findIndex((h: any) =>
      h.hooks?.some(
        (hh: any) =>
          typeof hh.command === 'string' && hh.command.includes('session-end.js')
      )
    );

    if (existingSessionEnd >= 0) {
      settings.hooks.SessionEnd[existingSessionEnd] = sessionEndEntry;
    } else {
      settings.hooks.SessionEnd.push(sessionEndEntry);
    }

    // Write back
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  }

  /** Recursively copy a directory. */
  private copyDirSync(src: string, dst: string): void {
    fs.mkdirSync(dst, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const dstPath = path.join(dst, entry.name);
      if (entry.isDirectory()) {
        this.copyDirSync(srcPath, dstPath);
      } else {
        fs.copyFileSync(srcPath, dstPath);
      }
    }
  }
}
