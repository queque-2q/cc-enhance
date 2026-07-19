# cc-diff

VSCode 扩展 —— 在 Claude Code 对话后展示文件 diff，提供文件级别和 Hunk 级别的 Accept（接受修改）/ Deny（还原修改）控制，类似 Copilot 的 diff 功能。

## 项目结构

```
cc-diff/
├── hooks/                    # Claude Code Hook 脚本
│   ├── pre-tool-use.js       # PreToolUse hook：编辑前保存文件快照
│   └── session-end.js        # SessionEnd hook：会话结束计算 diff，生成 patch
├── src/
│   ├── extension.ts      # 扩展入口
│   ├── DiffManager.ts    # 核心状态管理：加载 patch、Accept/Deny、反向 git apply
│   ├── WebviewProvider.ts # 侧边栏 Webview UI
│   └── types/
│       └── diff.d.ts     # diff 包的 TypeScript 类型声明
├── out/                  # 编译输出
├── package.json          # 扩展清单
└── tsconfig.json         # TypeScript 配置
├── test/
│   └── integration-test.sh   # Hooks 集成测试脚本
└── docs/
    └── superpowers/
        ├── specs/2026-07-03-cc-diff-design.md   # 设计文档
        └── plans/2026-07-03-cc-diff.md           # 实现计划
```

## 安装

### 1. 配置 Claude Code Hooks

在项目的 `.claude/settings.json` 中添加：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/cc-diff/hooks/pre-tool-use.js",
            "timeout": 10000
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/cc-diff/hooks/session-end.js",
            "timeout": 30000
          }
        ]
      }
    ]
  }
}
```

### 2. 安装 VSCode 扩展

```bash
cd vscode-extension
npm install
npm run compile
```

然后将 `vscode-extension` 目录复制或链接到 VSCode 扩展目录：
- Windows: `%USERPROFILE%\.vscode\extensions\cc-diff`
- Mac/Linux: `~/.vscode/extensions/cc-diff`

### 3. 重启 VSCode

在命令面板中选择 "Developer: Reload Window"。

## 使用

1. 在项目目录中启动 Claude Code 会话
2. 让 Claude Code 编辑文件
3. 会话结束时，VSCode 活动栏出现 "CC Diff" 图标
4. 点击图标查看所有变更文件及 Accept/Deny 控制
5. 点击文件名打开 VSCode 原生 Diff Editor（左侧 = 修改前，右侧 = 当前文件）
6. 逐个接受/拒绝变更，或批量操作

## 工作流程

```
Claude Code 编辑文件 → PreToolUse Hook 保存快照
                              ↓
                        会话结束
                              ↓
           SessionEnd Hook 计算 diff → 写入 patch JSON
                              ↓
              VSCode 扩展检测到 session.json
                              ↓
                Webview 侧边栏展示所有变更
                              ↓
      点击文件名 → VSCode Diff Editor（左: 修改前, 右: 当前）
                              ↓
        Accept 全部 / Deny 逐个 / 手动编辑后实时更新
```

## 数据存储

所有 diff 数据存储在 `<项目>/.claude/cc-diff/` 目录下：
- `patches/<session_id>/session.json` — 会话元数据（时间戳、文件列表）
- `patches/<session_id>/*.patch.json` — 每个文件的 hunk 级别 patch 数据

已完成的 session 在 24 小时后自动清理。

## 技术栈

| 组件 | 技术 |
|------|------|
| Hook 脚本 | Node.js CJS, `diff` npm 包 |
| VSCode 扩展 | TypeScript, VSCode Extension API |
| Webview UI | HTML + CSS + Vanilla JS（所有颜色使用 VSCode CSS 变量） |
| Diff 计算 | `diff` npm 包（unified diff） |
| Deny 操作 | `git apply --reverse` |
| 构建 | `tsc` |

## TODO

- 可编辑，编辑时修改原始文件
- 按钮水平，背景色设置

