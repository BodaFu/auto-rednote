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
  → HTTP → OpenClaw browser control server（127.0.0.1:18791）
  → Playwright → 你已登录的 Chrome
  → 小红书网页端（www.xiaohongshu.com）
```

插件不启动独立浏览器，而是控制 OpenClaw 已管理的 Chrome 实例，自动共享你的登录会话。

---

## 前置条件

| 依赖 | 说明 |
|---|---|
| [OpenClaw](https://github.com/openclaw/openclaw) | 已安装，Gateway 正在运行 |
| Chrome | 已在小红书网页端登录（`https://www.xiaohongshu.com`） |
| OpenClaw browser | 已通过 `openclaw browser start` 启动 |
| Node.js | ≥ 22（使用内置 `node:sqlite`） |

---

## 安装

### 1. 克隆到 OpenClaw 的 extensions 目录

```bash
cd /path/to/openclaw/extensions
git clone https://github.com/BodaFu/auto-rednote.git
```

### 2. 安装依赖

```bash
cd auto-rednote
npm install
```

### 3. 在 OpenClaw 配置中启用

在 OpenClaw 配置文件（通常为 `~/.openclaw/config.json`）中添加：

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

### 4. 重启 OpenClaw Gateway

```bash
kill -HUP $(pgrep -f openclaw-gateway)
```

---

## 配置项

| 配置项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `dbPath` | string | `~/.openclaw/auto-rednote.db` | 通知状态 SQLite 数据库路径 |
| `browserProfile` | string | （host Chrome） | OpenClaw browser profile 名称 |

---

## 工具列表（共 19 个）

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

- **SPA 预热**：小红书是 React SPA，插件会确保 Chrome 已访问首页完成 `window.__INITIAL_STATE__` 初始化，再提取数据。
- **数据提取**：优先从 `window.__INITIAL_STATE__` 提取结构化数据，降级到 DOM 解析。
- **API 拦截**：通知获取通过 OpenClaw 的 response body 端点拦截 `/api/sns/web/v1/you/mentions`。评论回复在页面注入持续拦截器（`window.__commentAPIEntries`），收集所有评论 API 响应，处理虚拟化渲染和多级评论结构。
- **多级评论处理**：`xhs_reply_comment` 实现了 4 级容错查找策略，包括从拦截的 API 数据中反推真实父评论 ID，应对虚拟化列表场景。
- **通知状态持久化**：使用 Node.js 内置 `node:sqlite` 将通知处理状态存储在本地 SQLite 数据库中。

---

## 版本历史

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
