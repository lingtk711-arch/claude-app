# Claude App

给 `claude` CLI（Claude Code）套的一层本地网页界面：聊天窗口 + 项目管理 + 多会话，浏览器里就能用，可以「安装」成独立窗口（PWA）。

零第三方依赖，后端就是一个 `server.js`。

## 功能

- **项目**：每个项目对应本机一个文件夹，Claude 在该目录下读写文件；内置文件夹浏览器
- **会话**：一个项目下多个会话，首轮用 `--session-id`，之后 `--resume` 保持上下文
- **流式输出**：逐字显示，随时可点「停止」
- **附件**：拖拽文件，或直接 `Ctrl+V` 粘贴截图（通过 `--add-dir` 授权）
- **可切换**：模型名、权限模式都在顶栏改

## 环境要求

- Node.js 18+（用了 `node:` 前缀和 `fs/promises`）
- 已经装好并能正常运行的 `claude` CLI，环境变量配好：

  | 变量 | 说明 |
  |---|---|
  | `ANTHROPIC_BASE_URL` | API 地址 |
  | `ANTHROPIC_API_KEY` | 密钥 |
  | `ANTHROPIC_MODEL` | 默认模型名（默认 `deepseek-v4-flash`） |
  | `CLAUDE_BIN` | 可选，手动指定 `claude` 可执行文件路径 |

  `claude` 找不到时，默认按 `~/.local/bin/claude.exe`、`~/.local/bin/claude` 顺序查找。

## 启动

Windows 双击 `启动.bat`，或直接：

```bash
node server.js
```

浏览器会自动打开 `http://127.0.0.1:8787`（端口可用 `PORT` 环境变量改）。只监听 `127.0.0.1`，不对外网开放。

## 数据

运行时数据都在 `data/` 下，属于本机状态，已从版本控制排除：

- `data/projects.json` — 项目列表
- `data/sessions.json` — 会话列表
- `data/uploads/` — 上传的附件

删掉 `data/` 就是全新状态。

## 安全提示

默认权限模式是 `bypassPermissions`。原因：App 以 `claude -p` 无人值守方式运行，**没有弹窗可以点「同意」**，任何需要批准的命令都会被静默拦掉。代价是 App 里的 Claude 不再询问就执行命令 —— 请只在你自己信任的机器和目录上使用。

## License

MIT
