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
  private logger: (msg: string) => void = () => {};

  /** Version marker written to the hooks target directory for update checks. */
  private static readonly VERSION_MARKER = 'cc-diff-hooks-v4';

  constructor(extensionPath: string) {
    this.extensionPath = extensionPath;
  }

  /** Attach an output channel for logging hook operations. */
  setLogger(logger: (msg: string) => void): void {
    this.logger = logger;
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
   *
   * Compares the full content of each hook script file (source vs target)
   * rather than relying solely on a version marker, so that any
   * corruption, manual edit, or partial update is detected.
   */
  async autoUpdate(workspaceRoot: string): Promise<void> {
    try {
      const targetDir = this.getTargetHooksDir(workspaceRoot);

      if (!fs.existsSync(targetDir)) {
        this.logger('autoUpdate: hooks not installed — skipping');
        return;
      }

      if (!this.needsUpdate(targetDir)) {
        this.logger('autoUpdate: hooks up to date — skipping');
        return;
      }

      // Log which files differ
      const diffs = this.getChangedFiles(targetDir);
      this.logger(`autoUpdate: updating hooks — changed files: ${diffs.join(', ') || 'all'}`);

      await this.copyHooksToTarget(targetDir);
      this.writeVersionMarker(targetDir);
      this.logger('autoUpdate: hooks updated successfully');
    } catch (e: any) {
      this.logger(`autoUpdate: ERROR — ${e.message || e}`);
    }
  }

  /** Return list of hook files that differ between source and target. */
  private getChangedFiles(targetDir: string): string[] {
    const sourceDir = this.getSourceHooksDir();
    const filesToCheck = ['pre-tool-use.js', 'session-end.js'];
    const changed: string[] = [];

    for (const file of filesToCheck) {
      const src = path.join(sourceDir, file);
      const dst = path.join(targetDir, file);
      if (!fs.existsSync(dst)) {
        changed.push(`${file} (missing)`);
        continue;
      }
      if (!fs.existsSync(src)) continue;
      const srcContent = fs.readFileSync(src, 'utf8');
      const dstContent = fs.readFileSync(dst, 'utf8');
      if (srcContent !== dstContent) {
        changed.push(file);
      }
    }
    return changed;
  }

  /**
   * Compare every bundled hook script against its installed counterpart.
   * Returns true if any script is missing or differs — a full content
   * comparison, not a version-number check.
   */
  private needsUpdate(targetDir: string): boolean {
    const sourceDir = this.getSourceHooksDir();
    const filesToCheck = ['pre-tool-use.js', 'session-end.js'];

    for (const file of filesToCheck) {
      const src = path.join(sourceDir, file);
      const dst = path.join(targetDir, file);

      // Source should always exist (it is bundled with the extension)
      if (!fs.existsSync(src)) {
        continue;
      }

      // Target missing → needs update
      if (!fs.existsSync(dst)) {
        return true;
      }

      // Full content comparison
      const srcContent = fs.readFileSync(src, 'utf8');
      const dstContent = fs.readFileSync(dst, 'utf8');
      if (srcContent !== dstContent) {
        return true;
      }
    }

    return false;
  }

  // ------------------------------------------------------------------
  // Setup command
  // ------------------------------------------------------------------

  /**
   * Full hook setup: copy scripts, install dependencies, update settings.json.
   * Called by the `cc-diff.setupHooks` command.
   */
  async setupHooks(workspaceRoot: string): Promise<void> {
    this.logger(`setupHooks: starting — workspaceRoot="${workspaceRoot}"`);

    const sourceDir = this.getSourceHooksDir();
    if (!fs.existsSync(sourceDir)) {
      this.logger(`setupHooks: ERROR — source dir not found: ${sourceDir}`);
      throw new Error(`Hooks source directory not found: ${sourceDir}`);
    }

    const targetDir = this.getTargetHooksDir(workspaceRoot);
    this.logger(`setupHooks: target="${targetDir}"`);

    // 1. Copy hook scripts
    await this.copyHooksToTarget(targetDir);
    this.logger('setupHooks: scripts copied');

    // 2. Write version marker
    this.writeVersionMarker(targetDir);

    // 3. Update .claude/settings.json
    await this.updateClaudeSettings(workspaceRoot, targetDir);
    this.logger('setupHooks: .claude/settings.json updated');
    this.logger('setupHooks: complete');
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

    // Stop: add or update cc-diff entry (fires after every Claude response turn)
    // matcher is REQUIRED by Claude Code schema; empty string = match all
    const stopEntry = {
      matcher: '',
      hooks: [
        {
          type: 'command',
          command: sessionEndCmd,
          timeout: 30000,
        },
      ],
    };

    if (!Array.isArray(settings.hooks.Stop)) {
      settings.hooks.Stop = [];
    }

    // Check if a cc-diff stop hook already exists
    const existingStop = settings.hooks.Stop.findIndex((h: any) =>
      h.hooks?.some(
        (hh: any) =>
          typeof hh.command === 'string' && hh.command.includes('session-end.js')
      )
    );

    if (existingStop >= 0) {
      settings.hooks.Stop[existingStop] = stopEntry;
    } else {
      settings.hooks.Stop.push(stopEntry);
    }

    // Also clean up any legacy SessionEnd entry
    if (settings.hooks.SessionEnd) {
      settings.hooks.SessionEnd = settings.hooks.SessionEnd.filter((h: any) =>
        !h.hooks?.some((hh: any) =>
          typeof hh.command === 'string' && hh.command.includes('session-end.js')
        )
      );
      if (settings.hooks.SessionEnd.length === 0) {
        delete settings.hooks.SessionEnd;
      }
    }

    // Write back
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  }

}
