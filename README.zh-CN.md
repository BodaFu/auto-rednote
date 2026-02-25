# auto-rednote

**小红书自动化运营 OpenClaw 插件。**

复用你已登录的 Chrome（通过 OpenClaw browser control），让 AI Agent 获得完整的小红书网页端操作能力——无需独立浏览器进程，无需 API Key，无需逆向工程。

[English →](./README.md)

---

## 工作原理

```
AI Agent（Claude / Gemini / …）
  → xhs_* 工具调用
  → auto-rednote 插件（TypeScript）
  → 进程内调用 → OpenClaw browser control
  → Playwright → OpenClaw 管理的 Chrome（openclaw profile）
  → 小红书网页端（www.xiaohongshu.com）
```

插件通过**进程内调用**直接使用 OpenClaw 的 browser control，无需独立 HTTP 端口。它控制 OpenClaw 管理的 Chromium 实例，自动共享你的登录会话。

---

## 前置条件

| 依赖 | 说明 |
|---|---|
| [OpenClaw](https://github.com/openclaw/openclaw) | 已安装，Gateway 正在运行（`openclaw gateway`） |
| OpenClaw browser | 已通过 `openclaw browser` 启动（使用内置 `openclaw` Chrome profile） |
| Node.js | ≥ 22（使用内置 `node:sqlite`） |
| 小红书账号 | 已在 OpenClaw browser 中登录（见下方步骤） |

---

## 安装步骤

### 第 1 步 — 找到 OpenClaw 的 extensions 目录

extensions 目录紧邻 OpenClaw 安装目录：

```bash
# npm 全局安装（最常见）
ls $(npm root -g)/openclaw/extensions/

# Homebrew
ls /opt/homebrew/lib/node_modules/openclaw/extensions/

# 源码目录
ls /path/to/openclaw/extensions/
```

> **提示**：运行 `openclaw doctor`，输出中会显示 gateway 二进制路径，`extensions/` 就在同级目录下。

### 第 2 步 — 将 auto-rednote clone 到 extensions 目录

```bash
cd $(npm root -g)/openclaw/extensions   # 根据你的安装方式调整路径
git clone https://github.com/BodaFu/auto-rednote.git
cd auto-rednote
npm install
```

### 第 3 步 — 在 OpenClaw 配置中启用

打开 `~/.openclaw/openclaw.json`（不存在则新建），添加：

```json
{
  "plugins": {
    "entries": {
      "auto-rednote": {
        "enabled": true
      }
    }
  }
}
```

可选：指定自定义数据库路径：

```json
{
  "plugins": {
    "entries": {
      "auto-rednote": {
        "enabled": true,
        "config": {
          "dbPath": "~/.openclaw/auto-rednote.db"
        }
      }
    }
  }
}
```

### 第 4 步 — 在 OpenClaw browser 中登录小红书

OpenClaw 管理一个独立的 Chrome profile（`openclaw`），需要在这个浏览器里登录小红书：

```bash
openclaw browser
```

这会打开 OpenClaw 的 Chromium 窗口。访问 `https://www.xiaohongshu.com` 正常登录即可。登录状态会持久化在 `openclaw` profile 中。

### 第 5 步 — 重启 Gateway

```bash
# 发送 HUP 信号，热重载插件（无需完整重启）
kill -HUP $(pgrep -f "openclaw.*gateway")

# 或者完整重启
openclaw gateway --force
```

### 第 6 步 — 验证

向你的 Agent 发送：*"调用 xhs_check_login，告诉我结果。"*

预期返回：`{ "loggedIn": true, "message": "已登录" }`

---

## 配置项

| 配置项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `dbPath` | string | `~/.openclaw/auto-rednote.db` | 通知状态 SQLite 数据库路径 |

> `browserProfile` 配置项无需设置——插件始终使用 OpenClaw 内置的 `openclaw` Chrome profile。

---

## 工具列表（共 26 个）

### 账号工具

| 工具 | 说明 |
|---|---|
| `xhs_check_login` | 检查小红书登录状态 |
| `xhs_get_qrcode` | 获取登录二维码 URL（未登录时） |
| `xhs_my_profile` | 获取我的主页信息 |
| `xhs_my_notes` | 获取我的笔记列表（含互动数据） |

### 内容工具

| 工具 | 说明 |
|---|---|
| `xhs_list_feeds` | 获取首页推荐 Feed 列表 |
| `xhs_search` | 按关键词、排序、类型、时间范围搜索笔记 |
| `xhs_get_feed` | 获取帖子详情（含评论） |
| `xhs_get_user` | 获取用户主页信息和笔记列表 |

### 互动工具

| 工具 | 说明 |
|---|---|
| `xhs_post_comment` | 在笔记下发表顶级评论 |
| `xhs_reply_comment` | 回复评论（支持多级评论结构） |
| `xhs_like` | 点赞 / 取消点赞笔记 |
| `xhs_collect` | 收藏 / 取消收藏笔记 |
| `xhs_follow` | 关注 / 取消关注用户 |

### 通知工具

| 工具 | 说明 |
|---|---|
| `xhs_get_notifications` | 获取原始通知列表（评论、回复、@提及） |
| `xhs_get_notifications_pending` | 获取待处理通知（Agent 心跳循环专用） |
| `xhs_mark_notification` | 标记通知处理结果（replied / skipped / retry） |
| `xhs_notification_stats` | 获取通知处理状态统计 |

### 发布工具

| 工具 | 说明 |
|---|---|
| `xhs_publish` | 发布图文或视频笔记 |

### 桌面 IM 工具（私信回复）— 仅 macOS

> 需要小红书 macOS App（rednote，Mac App Store 可下载）以**全屏模式**运行在独立 Space 中。网页版小红书不支持私信功能。

| 工具 | 说明 |
|---|---|
| `xhs_desktop_im_unread` | 扫描未读私信 — 导航到「消息」Tab，截图返回供视觉分析，同时返回未读角标元素 |
| `xhs_desktop_im_inbox` | 截图消息收件箱（不过滤未读状态） |
| `xhs_desktop_im_open` | 通过坐标 `(x, y)` 或元素 ID 打开指定对话 |
| `xhs_desktop_im_send` | 在当前已打开的对话中发送私信 |
| `xhs_desktop_im_back` | 返回上一页（点击左上角 `<` 按钮） |
| `xhs_desktop_im_see` | 列出当前界面所有 UI 元素（调试 / 动态元素定位） |
| `xhs_desktop_screenshot` | 截图当前小红书 App 界面 |

---

## 使用示例

### 自动回复新评论

```
用户：帮我检查小红书有没有新评论，如果有就回复"谢谢支持！"

Agent 调用流程：
1. xhs_check_login                → 确认已登录
2. xhs_get_notifications { maxPages: 2 }
3. 过滤 comment_on_my_note / reply_to_my_comment 类型
4. xhs_reply_comment { feedId, xsecToken, commentId, content: "谢谢支持！" }
5. xhs_mark_notification { id, status: "replied" }
```

### 自动回复私信

```
用户：帮我查一下小红书有没有新私信，有的话帮我回复

Agent 调用流程：
1. xhs_desktop_im_unread          → 截图消息列表 + 未读角标信息
2. 视觉分析截图，找到有未读的对话行及其坐标 (x, y)
3. xhs_desktop_im_open { x, y }   → 打开对话，截图显示消息历史
4. 读取截图中的消息内容
5. xhs_desktop_im_send { text: "..." }  → 发送回复
6. 视觉确认回复已出现在对话中
7. xhs_desktop_im_back            → 返回收件箱，继续处理下一条
```

### 搜索并点赞

```
用户：搜索"手机摄影技巧"，点赞前3条

Agent 调用流程：
1. xhs_search { keyword: "手机摄影技巧", sortBy: "most_liked" }
2. 取前3条结果
3. xhs_like { feedId, xsecToken } × 3
```

---

## 技术说明

- **HTTP 浏览器控制**：插件通过原生 `fetch()` 直接调用 OpenClaw Gateway 的浏览器控制 HTTP 服务，避免 `jiti` 模块隔离导致的 Playwright 连接冲突，由 Gateway 统一管理浏览器实例。
- **SPA 预热**：小红书是 React SPA，插件会确保 Chrome 已访问首页完成 `window.__INITIAL_STATE__` 初始化，再提取数据。
- **数据提取**：优先从 `window.__INITIAL_STATE__` 提取结构化数据，降级到 DOM 解析。
- **API 拦截**：通知获取拦截 `/api/sns/web/v1/you/mentions`。评论回复在页面注入持续拦截器（`window.__commentAPIEntries`），处理虚拟化渲染和多级评论结构。
- **多级评论处理**：`xhs_reply_comment` 实现了 4 级容错查找策略，包括从拦截的 API 数据中反推真实父评论 ID。
- **通知状态持久化**：使用 Node.js 内置 `node:sqlite` 将通知处理状态存储在本地 SQLite 数据库中。
- **桌面 IM — Space 切换**：小红书 macOS App 在独立全屏 Space 运行。`activateApp` 使用 `System Events set frontmost to true`（唯一能跨 Space 切换的方式），而非 `tell application X to activate`（只激活进程，不切换 Space）。截图在 Space 切换动画完成后（~800ms）由 `screencapture -R` 执行。
- **桌面 IM — iOS on Mac 限制**：该 App 是 iOS 移植版，Accessibility 树质量极低（大多数元素标注为"按钮"/"文本"）。工具实现了优雅降级：`peekaboo see` 失败时自动回退到纯截图视觉分析。点击操作使用从已知窗口区域（x=0, y=33, 1512×949）推算的绝对屏幕坐标。

---

## 常见问题

**`plugin not found: auto-rednote`**
找不到插件目录。确认 `auto-rednote/` 直接位于 OpenClaw 安装目录下的 `extensions/` 文件夹内，且已在目录内执行 `npm install`。

**`Can't reach the OpenClaw browser control service`**
OpenClaw browser 尚未启动，或 Chromium 进程崩溃。运行 `openclaw browser` 打开浏览器窗口，等待几秒后重试。

**`{ "loggedIn": false }`**
需要在 OpenClaw Chromium 窗口中登录小红书。运行 `openclaw browser`，访问 `https://www.xiaohongshu.com` 并登录。

**工具在命令行测试正常，但通过 Agent 调用超时**
这通常发生在 gateway 刚重启后，browser control service 还在初始化。等待 10–15 秒后重试。

---

## 版本历史

### v2026.2.25

- **新增：桌面 IM 工具** — 7 个新的 `xhs_desktop_*` 工具，通过小红书 macOS App 实现私信回复能力
  - `xhs_desktop_im_unread`、`xhs_desktop_im_inbox`、`xhs_desktop_im_open`、`xhs_desktop_im_send`、`xhs_desktop_im_back`、`xhs_desktop_im_see`、`xhs_desktop_screenshot`
- 修复全屏 Space 切换：`activateApp` 改用 `System Events set frontmost` 正确跨 Space 切换
- 修复跨 Space 截图：`screenshot()` 先激活 App 等待动画完成（800ms）再截图
- 校准全屏 1512×949 布局的 UI 坐标（输入框 y=930，返回按钮 y=30）
- `xhs_search` 新增 `limit` 参数（默认 20），控制返回条数

### v2026.2.24

- 全面重构通知解析与评论查找逻辑
- 新增 `injectCommentAPIInterceptor`：持续收集评论 API 响应
- 重写 `scrollToComment` 与 `expandAndFindSubComment`：停滞检测 + has_more 判断
- 补全 `replyComment` 4 级容错路径
- 修复 `followUser` ReferenceError
- 增强 `parseCommentApiResponse`：返回 subCommentCount / subCommentHasMore

### v2026.2.22

- 初始版本，实现 19 个核心工具
- 覆盖账号、内容、互动、通知、发布全域能力

---

## License

MIT — 详见 [LICENSE](./LICENSE)。

本项目与小红书官方无关，不受其背书。
