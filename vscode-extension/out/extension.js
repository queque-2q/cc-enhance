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
const vscode = __importStar(require("vscode"));
const DiffManager_1 = require("./DiffManager");
const WebviewProvider_1 = require("./WebviewProvider");
const HooksManager_1 = require("./HooksManager");
let diffManager;
let webviewProvider;
let hooksManager;
let fileWatcher;
let changeListener;
function activate(context) {
    // Determine workspace root
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return; // No workspace open — nothing to do
    }
    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    // Auto-update hooks if already installed (best-effort, don't block)
    hooksManager = new HooksManager_1.HooksManager(context.extensionPath);
    hooksManager.autoUpdate(workspaceRoot);
    // Initialize DiffManager and load existing sessions
    diffManager = new DiffManager_1.DiffManager();
    diffManager.loadSessions(workspaceRoot);
    diffManager.cleanOldSessions(workspaceRoot);
    // Create WebviewProvider
    webviewProvider = new WebviewProvider_1.WebviewProvider(workspaceRoot, diffManager);
    // Register the sidebar webview
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('cc-diff.view', webviewProvider));
    // Watch for new session.json signal files
    // VSCode's FileSystemWatcher uses workspace-relative patterns
    const watchPattern = new vscode.RelativePattern(workspaceFolders[0], '.claude/cc-diff/patches/*/session.json');
    fileWatcher = vscode.workspace.createFileSystemWatcher(watchPattern, false, false, false);
    context.subscriptions.push(fileWatcher);
    fileWatcher.onDidCreate(() => {
        diffManager.loadSessions(workspaceRoot);
        webviewProvider.refresh();
    });
    fileWatcher.onDidChange(() => {
        diffManager.loadSessions(workspaceRoot);
        webviewProvider.refresh();
    });
    fileWatcher.onDidDelete(() => {
        diffManager.loadSessions(workspaceRoot);
        webviewProvider.refresh();
    });
    // Listen for manual file edits (100ms debounce via the provider)
    changeListener = vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.scheme !== 'file')
            return;
        const relativePath = vscode.workspace.asRelativePath(e.document.uri);
        webviewProvider.notifyFileChanged(relativePath);
    });
    context.subscriptions.push(changeListener);
    // Status bar item
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'cc-diff.focus';
    statusBarItem.text = '$(diff) CC Diff';
    statusBarItem.tooltip = 'Show CC Diff panel';
    context.subscriptions.push(statusBarItem);
    statusBarItem.show();
    // Register the focus command
    context.subscriptions.push(vscode.commands.registerCommand('cc-diff.focus', () => {
        vscode.commands.executeCommand('cc-diff.view.focus');
    }));
    // Register the setupHooks command
    context.subscriptions.push(vscode.commands.registerCommand('cc-diff.setupHooks', async () => {
        try {
            await hooksManager.setupHooks(workspaceRoot);
            vscode.window.showInformationMessage('CC Diff: Hook 脚本安装成功！请查看 .claude/settings.json');
        }
        catch (err) {
            vscode.window.showErrorMessage(`CC Diff: Hook 安装失败 — ${err.message}`);
        }
    }));
}
function deactivate() {
    if (fileWatcher) {
        fileWatcher.dispose();
    }
    if (changeListener) {
        changeListener.dispose();
    }
}
//# sourceMappingURL=extension.js.map