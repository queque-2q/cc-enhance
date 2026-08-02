# cc-diff

[English](README.en.md) | [中文](README.zh-CN.md)

VSCode 扩展 —— 在 Claude Code 对话后展示文件 diff，提供文件级别和 Hunk 级别的 Keep（接受修改）/ Undo（还原修改）控制，类似 Copilot 的 diff 功能。

## 项目结构

```
cc-diff/
├── hooks/                    # Claude Code Hook 脚本
│   ├── pre-tool-use.js       # PreToolUse hook：编辑前保存文件快照
│   └── session-end.js        # SessionEnd hook：会话结束计算 diff，生成 patch
├── src/
│   ├── extension.ts      # 扩展入口
│   ├── DiffManager.ts    # 核心状态管理：加载 patch、Keep/Undo、反向 git apply
│   ├── WebviewProvider.ts # 侧边栏 Webview UI
│   └── types/
│       └── diff.d.ts     # diff 包的 TypeScript 类型声明
├── out/                  # 编译输出
├── package.json          # 扩展清单
├── tsconfig.json         # TypeScript 配置
├── test/
│   └── integration-test.sh   # Hooks 集成测试脚本
└── docs/
    └── superpowers/
        ├── specs/2026-07-03-cc-diff-design.md   # 设计文档
        └── plans/2026-07-03-cc-diff.md           # 实现计划
```

## 使用

### 初次配置

在命令面板 (`Ctrl+Shift+P`) 中执行 **CC Diff: 安装 Hook 脚本** 命令，插件会自动为当前工作区部署和配置 Claude Code hook 脚本。

### 日常使用

1. 启动 Claude Code 会话，让 Claude Code 编辑文件
2. 会话结束后，会弹出侧边栏，查看所有变更文件及 Keep/Undo 控制
3. 点击文件可在 Monaco Diff Editor 中查看差异（支持并排/统一视图）
4. 使用工具栏按钮或命令面板逐文件或批量接受/撤销变更

## 命令

所有命令均可通过命令面板 (`Ctrl+Shift+P`) 在 **CC Diff** 分类下使用：

| 命令 | 标题 | 描述 |
| --- | --- | --- |
| `cc-diff.setupHooks` | **安装 Hook 脚本** | 为当前工作区部署和配置 Claude Code hook 脚本（`pre-tool-use.js`、`session-end.js`） |
| `cc-diff.keepAllFileEditor` | **全部接受** | 接受当前文件中的所有变更（在 Monaco Diff Editor 中可见） |
| `cc-diff.undoAllFileEditor` | **全部撤销** | 还原当前文件中的所有变更（在 Monaco Diff Editor 中可见） |
| `cc-diff.prevHunk` | **上一个 Hunk** | 导航到上一个 diff 块 |
| `cc-diff.nextHunk` | **下一个 Hunk** | 导航到下一个 diff 块 |
| `cc-diff.toggleDiffMode` | **切换 Diff 模式** | 在统一视图（inline）和并排视图（side-by-side）之间切换 |
| `cc-diff.openCurrentFile` | **打开文件** | 在 VSCode 编辑器中打开当前文件 |

**切换 Diff 模式** 和 **打开文件** 命令也会显示在 Monaco Diff Editor 标题栏的工具栏中。

## 工作流程

```
Claude Code 编辑文件 → PreToolUse Hook 保存快照
                              ↓
                        会话结束
                              ↓
           SessionEnd Hook 计算 diff → 写入 patch JSON
                              ↓
              VSCode 扩展检测到 index.json
                              ↓
                Webview 侧边栏展示所有变更
                              ↓
      点击文件名 → VSCode Diff Editor（左: 修改前, 右: 当前）
                              ↓
        Keep 全部 / Undo 逐个 / 手动编辑后实时更新
```

## 数据存储

所有 diff 数据存储在 `<项目>/.claude/cc-diff/` 目录下：

- `patches/index.json` — 全局清单，包含所有 patch，按时间戳排序
- `patches/<timestamp>-<sessionId>-<safeFile>.patch.json` — 每个文件的 hunk 级别 patch 数据（扁平存储）
- `snapshots/` — 编辑前的文件快照

已完成的 session 在 24 小时后自动清理。

## 技术栈

| 组件 | 技术 |
|------|------|
| Hook 脚本 | Node.js CJS, `diff` npm 包 |
| VSCode 扩展 | TypeScript, VSCode Extension API |
| Webview UI | HTML + CSS + Vanilla JS（所有颜色使用 VSCode CSS 变量） |
| Diff 计算 | `diff` npm 包（unified diff） |
| Undo 操作 | `git apply --reverse` |
| 构建 | `tsc` |

## 许可证

本项目使用 [MIT License](LICENSE) 开源许可。
