"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const SnapshotManager_1 = require("./SnapshotManager");
const WebviewProvider_1 = require("./WebviewProvider");
const DiffPanelProvider_1 = require("./DiffPanelProvider");
const HooksManager_1 = require("./HooksManager");
let snapshotManager;
let webviewProvider;
let diffPanelProvider;
let hooksManager;
let fileWatcher;
let outputChannel;
function log(msg) {
    const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
    outputChannel.appendLine(`[${ts}] ${msg}`);
}
function activate(context) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return;
    }
    const workspaceRoot = path.resolve(workspaceFolders[0].uri.fsPath);
    // ── Output channel ──
    outputChannel = vscode.window.createOutputChannel('CC Diff', { log: true });
    context.subscriptions.push(outputChannel);
    log(`Extension activated — workspace: ${workspaceRoot}`);
    // ── Hooks auto-update ──
    hooksManager = new HooksManager_1.HooksManager(context.extensionPath);
    hooksManager.setLogger(log);
    log('Checking hook scripts for updates...');
    hooksManager.autoUpdate(workspaceRoot);
    // ── SnapshotManager ──
    snapshotManager = new SnapshotManager_1.SnapshotManager();
    snapshotManager.setLogger(log);
    snapshotManager.setWorkspaceRoot(workspaceRoot);
    snapshotManager.loadFiles(workspaceRoot);
    // ── DiffPanelProvider ──
    diffPanelProvider = new DiffPanelProvider_1.DiffPanelProvider(workspaceRoot, snapshotManager, outputChannel);
    // When diff panel is closed, refresh the sidebar
    diffPanelProvider.onPanelDisposed = () => {
        webviewProvider.refresh();
    };
    // ── WebviewProvider ──
    webviewProvider = new WebviewProvider_1.WebviewProvider(workspaceRoot, snapshotManager, outputChannel, diffPanelProvider);
    // ── Sidebar webview ──
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('cc-diff.view', webviewProvider));
    // ── File watcher: index.json ──
    const watchPattern = new vscode.RelativePattern(workspaceFolders[0], '.claude/cc-diff/index.json');
    fileWatcher = vscode.workspace.createFileSystemWatcher(watchPattern, false, false, false);
    context.subscriptions.push(fileWatcher);
    fileWatcher.onDidCreate((uri) => {
        log(`FileWatcher: index.json created — ${uri.fsPath}`);
        snapshotManager.loadFiles(workspaceRoot);
        webviewProvider.refresh();
        if (snapshotManager.getAllFiles().length > 0) {
            vscode.commands.executeCommand('cc-diff.view.focus');
        }
    });
    fileWatcher.onDidChange((uri) => {
        const before = snapshotManager.getAllFiles().length;
        log(`FileWatcher: index.json changed — ${uri.fsPath}`);
        snapshotManager.loadFiles(workspaceRoot);
        webviewProvider.refresh();
        const after = snapshotManager.getAllFiles().length;
        if (after > before) {
            vscode.commands.executeCommand('cc-diff.view.focus');
            log(`FileWatcher: auto-focused cc-diff view (files: ${before} → ${after})`);
        }
    });
    fileWatcher.onDidDelete(() => {
        log('FileWatcher: index.json deleted');
        snapshotManager.loadFiles(workspaceRoot);
        webviewProvider.refresh();
    });
    // ── Status bar ──
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'cc-diff.focus';
    statusBarItem.text = '$(diff) CC Diff';
    statusBarItem.tooltip = 'Show CC Diff panel';
    context.subscriptions.push(statusBarItem);
    statusBarItem.show();
    // ── Commands ──
    context.subscriptions.push(vscode.commands.registerCommand('cc-diff.focus', () => {
        vscode.commands.executeCommand('cc-diff.view.focus');
    }));
    context.subscriptions.push(vscode.commands.registerCommand('cc-diff.setupHooks', async () => {
        log('Command: setupHooks invoked');
        try {
            await hooksManager.setupHooks(workspaceRoot);
            log('Command: setupHooks succeeded');
            vscode.window.showInformationMessage('CC Diff: Hook 脚本安装成功！请查看 .claude/settings.json');
        }
        catch (err) {
            log(`Command: setupHooks FAILED — ${err.message}`);
            vscode.window.showErrorMessage(`CC Diff: Hook 安装失败 — ${err.message}`);
        }
    }));
    log('Activation complete.');
}
function deactivate() {
    log('Extension deactivated.');
    if (fileWatcher) {
        fileWatcher.dispose();
    }
}
//# sourceMappingURL=extension.js.map