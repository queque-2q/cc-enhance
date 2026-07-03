# CLAUDE.md

## 项目概述

cc-diff 是一个 VSCode 扩展，在 Claude Code 对话结束后自动展示文件修改 diff，提供文件级别和 Hunk 级别的 Accept（接受）/ Deny（还原）控制，类似 Copilot 的 diff 功能。

## 架构

```
Claude Code Hooks                    VSCode 扩展
─────────────────                    ──────────
pre-tool-use.js  ──快照──▶  .claude/cc-diff/  ──监听──▶  extension.ts
session-end.js   ──patch──▶  snapshots/patches/              ├─ DiffManager.ts
                                                             ├─ WebviewProvider.ts
                                                             └─ HooksManager.ts
```

- **Hook 脚本** (CJS, Node.js)：PreToolUse 保存文件快照，SessionEnd 计算 unified diff → patch JSON
- **VSCode 扩展** (TypeScript)：监听 `session.json` 信号文件 → 侧边栏 Webview 展示 diff → Accept/Deny
- **通信方式**：通过 `<workspace>/.claude/cc-diff/` 目录进行文件系统通信

## 开发命令

```bash
# 编译
cd vscode-extension && npx tsc -p ./

# 类型检查（不输出文件）
cd vscode-extension && npx tsc --noEmit

# 运行集成测试
bash test/integration-test.sh

# 打包 VSIX
powershell -File scripts/package.ps1           # 完整流程
powershell -File scripts/package.ps1 -SkipTests # 跳过测试

# F5 调试
在 VSCode 中打开 vscode-extension/，按 F5 启动扩展开发宿主
```

## 关键文件

| 文件 | 用途 |
|------|------|
| `vscode-extension/src/extension.ts` | 扩展入口：激活、命令注册、文件监听 |
| `vscode-extension/src/DiffManager.ts` | 核心状态管理：加载 patch、Accept/Deny、git apply --reverse |
| `vscode-extension/src/WebviewProvider.ts` | 侧边栏 Webview UI（HTML/CSS/JS 内联） |
| `vscode-extension/src/HooksManager.ts` | Hook 部署和自动更新 |
| `vscode-extension/hooks/pre-tool-use.js` | PreToolUse hook：编辑前保存快照 |
| `vscode-extension/hooks/session-end.js` | SessionEnd hook：计算 diff、生成 patch |
| `test/integration-test.sh` | Hooks 端到端集成测试 |
| `scripts/package.ps1` | 一键打包脚本 |

## 数据流

1. Claude Code 编辑文件前 → `pre-tool-use.js` 保存原始内容到 `.claude/cc-diff/snapshots/<session>/`
2. 会话结束 → `session-end.js` 对比快照和当前文件，生成 unified diff → 写入 `patches/<session>/*.patch.json` + `session.json`
3. 扩展的 `FileSystemWatcher` 检测到 `session.json` → `DiffManager` 加载数据 → `WebviewProvider` 刷新 UI
4. 用户 Accept → 仅标记状态；Deny → `git apply --reverse` 还原修改
5. 24 小时后自动清理已完成的 session

## 技术栈

- Hook 脚本：Node.js CJS，依赖 `diff` npm 包
- VSCode 扩展：TypeScript strict，VSCode API ^1.85
- Webview：HTML + CSS + Vanilla JS，全部使用 `var(--vscode-*)` CSS 变量
- 构建：`tsc`
- 打包：`@vscode/vsce`

## 注意事项

- Hook 脚本永远不能阻塞编辑器（所有错误 → exit 0）
- Webview CSS 绝不硬编码颜色，必须使用 VSCode CSS 变量
- patches 中的文件路径使用 POSIX 正斜杠（SessionEnd hook 生成），DiffManager 加载时需要处理路径兼容
- Windows 上 `Join-Path` 只接受两个参数，多级路径需要嵌套调用
