# auto-rednote

**OpenClaw 小红书自动化扩展** — 19 个工具实现内容管理、互动、通知和发布全流程自动化。

[![GitHub stars](https://img.shields.io/github/stars/BodaFu/auto-rednote?style=flat-square)](https://github.com/BodaFu/auto-rednote/stargazers)
[![License](https://img.shields.io/github/license/BodaFu/auto-rednote?style=flat-square)](https://github.com/BodaFu/auto-rednote/blob/main/LICENSE)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-skill-orange?style=flat-square)](https://openclaw.ai)

---

## 📖 简介

auto-rednote 是 OpenClaw 的扩展技能（skill），专为小红书（Xiaohongshu/RedNote）运营自动化设计。提供 19 个工具，覆盖内容创作、互动管理、通知处理、笔记发布等全流程。

**核心能力：**
- 📝 **内容管理** - 获取笔记详情、评论列表、用户信息
- 💬 **互动自动化** - 点赞、收藏、评论、回复
- 🔔 **通知处理** - 获取通知、标记处理状态、通知统计
- 📤 **内容发布** - 发布图文/视频笔记、定时发布
- 📊 **数据分析** - 获取账号信息、笔记互动数据、运营状态

**适用场景：**
- 个人小红书账号自动化运营
- 品牌/商家多账号管理
- 内容创作者数据分析
- 社交媒体自动化研究

---

## 🚀 快速开始

### 前置要求

- Node.js 22+
- OpenClaw Gateway 已运行
- 小红书账号已登录（通过 OpenClaw 浏览器）

### 安装

#### 方式 1：ClawHub 安装（推荐）

```bash
npx clawhub@latest install auto-rednote
```

#### 方式 2：手动安装

```bash
# 克隆或复制到 skills 目录
cp -r auto-rednote ~/.openclaw/skills/

# 重启 OpenClaw Gateway
openclaw gateway restart
```

### 配置

1. **登录小红书**
   ```bash
   openclaw browser
   # 在浏览器中登录小红书
   ```

2. **验证登录状态**
   ```
   调用：xhs_check_login()
   返回：{ "loggedIn": true }
   ```

---

## 🛠️ 工具列表

### 内容管理 (6 个)

| 工具 | 描述 | 示例 |
|------|------|------|
| `xhs_get_feed` | 获取笔记详情和评论 | `xhs_get_feed(feedId="xxx", xsecToken="xxx")` |
| `xhs_get_user` | 获取用户主页信息 | `xhs_get_user(userId="xxx", xsecToken="xxx")` |
| `xhs_my_profile` | 获取当前账号主页信息 | `xhs_my_profile()` |
| `xhs_my_notes` | 获取已发布笔记列表 | `xhs_my_notes()` |
| `xhs_list_feeds` | 获取首页推荐 Feed | `xhs_list_feeds(limit=10)` |
| `xhs_search` | 搜索笔记内容 | `xhs_search(keyword="穿搭", limit=8)` |

### 互动管理 (6 个)

| 工具 | 描述 | 示例 |
|------|------|------|
| `xhs_like` | 点赞/取消点赞笔记 | `xhs_like(feedId="xxx", xsecToken="xxx")` |
| `xhs_collect` | 收藏/取消收藏笔记 | `xhs_collect(feedId="xxx", xsecToken="xxx")` |
| `xhs_follow` | 关注/取消关注用户 | `xhs_follow(userId="xxx", xsecToken="xxx")` |
| `xhs_post_comment` | 发表顶级评论 | `xhs_post_comment(feedId="xxx", content="xxx")` |
| `xhs_reply_comment` | 回复评论（含楼中楼） | `xhs_reply_comment(feedId="xxx", commentId="xxx", content="xxx")` |
| `xhs_get_sub_comments` | 获取子评论列表 | `xhs_get_sub_comments(feedId="xxx", parentCommentId="xxx")` |

### 通知处理 (4 个)

| 工具 | 描述 | 示例 |
|------|------|------|
| `xhs_get_notifications_pending` | 获取待处理通知 | `xhs_get_notifications_pending()` |
| `xhs_mark_notification` | 标记通知处理状态 | `xhs_mark_notification(notificationId="xxx", status="replied")` |
| `xhs_notification_stats` | 获取通知状态统计 | `xhs_notification_stats()` |
| `xhs_get_qrcode` | 获取登录二维码 | `xhs_get_qrcode()` |

### 内容发布 (3 个)

| 工具 | 描述 | 示例 |
|------|------|------|
| `xhs_publish` | 发布图文/视频笔记 | `xhs_publish(type="image", title="标题", content="正文", mediaPaths=["/path/to/image.jpg"])` |
| `xhs_desktop_im_scan_inbox` | 扫描桌面版消息列表 | `xhs_desktop_im_scan_inbox()` |
| `xhs_desktop_im_send` | 发送私信消息 | `xhs_desktop_im_send(text="消息内容")` |

---

## 📖 使用示例

### 示例 1：获取笔记详情

```javascript
// 获取笔记详情和评论
const feed = await xhs_get_feed({
  feedId: "69993267000000000b00a57c",
  xsecToken: "LBoaSdMTrGxymA1W3BrWNGEa7M7kye01S14aXrSuhqdLg="
});

console.log(`标题：${feed.noteCard.title}`);
console.log(`点赞：${feed.noteCard.interactInfo.likedCount}`);
console.log(`评论数：${feed.noteCard.interactInfo.commentCount}`);
```

### 示例 2：自动互动

```javascript
// 搜索笔记并互动
const results = await xhs_search({
  keyword: "穿搭",
  limit: 8,
  sortBy: "latest"
});

for (const note of results) {
  // 点赞
  await xhs_like({
    feedId: note.id,
    xsecToken: note.xsecToken
  });
  
  // 收藏优质内容
  if (note.noteCard.interactInfo.likedCount > 1000) {
    await xhs_collect({
      feedId: note.id,
      xsecToken: note.xsecToken
    });
  }
}
```

### 示例 3：发布笔记

```javascript
// 发布图文笔记
await xhs_publish({
  type: "image",
  title: "边牧的委屈脸，拿捏了",
  content: "今天带狗狗去公园，它被欺负了，好委屈🥺",
  mediaPaths: ["/tmp/dog_photo.jpg"],
  tags: ["宠物", "狗狗", "边牧", "萌宠"]
});
```

### 示例 4：处理通知

```javascript
// 获取待处理通知
const notifications = await xhs_get_notifications_pending();

for (const notify of notifications.pending) {
  // 回复评论
  await xhs_reply_comment({
    feedId: notify.feedId,
    xsecToken: notify.xsecToken,
    commentId: notify.commentId,
    content: "谢谢你的评论！😊"
  });
  
  // 标记为已回复
  await xhs_mark_notification({
    notificationId: notify.notificationId,
    status: "replied",
    replyContent: "谢谢你的评论！😊"
  });
}
```

---

## 🔧 高级功能

### Heartbeat 自动运营

auto-rednote 支持 Heartbeat 心跳机制，实现自动化运营：

```javascript
// Heartbeat 流程
1. 检查登录状态 → xhs_check_login()
2. 获取待处理通知 → xhs_get_notifications_pending()
3. 回复通知 → xhs_reply_comment()
4. 刷 Feed 互动 → xhs_search() + xhs_like() + xhs_post_comment()
5. 关注有趣用户 → xhs_follow()
6. 更新运营状态 → 更新 xhs-state.md
```

**心跳频率：** 每 12 分钟一次

**每日限制：**
- 发帖：≤ 2 篇
- 评论：≤ 100 条
- 关注：≤ 10 个用户

### 桌面版私信

支持小红书桌面版私信自动化：

```javascript
// 扫描消息列表
const inbox = await xhs_desktop_im_scan_inbox();

// 打开对话
await xhs_desktop_im_open({
  x: inbox.visibleRows[0].clickX,
  y: inbox.visibleRows[0].clickY
});

// 发送消息
await xhs_desktop_im_send({
  text: "你好！"
});
```

---

## 📁 项目结构

```
auto-rednote/
├── SKILL.md                 # 技能定义
├── README.md                # 本文档
├── tools/
│   ├── content.js           # 内容管理工具
│   ├── interaction.js       # 互动工具
│   ├── notification.js      # 通知工具
│   └── publish.js           # 发布工具
├── scripts/
│   ├── heartbeat.js         # Heartbeat 脚本
│   └── security-check.js    # 安全检查
└── memory/
    ├── xhs-state.md         # 运营状态
    ├── xhs-notes.md         # 笔记注册表
    ├── xhs-digest.md        # 内容摘要
    └── xhs-social-circle.md # 社交圈
```

---

## 🔒 安全说明

### 频率限制

为避免触发小红书风控，请遵守以下限制：

| 操作 | 频率限制 | 说明 |
|------|---------|------|
| 点赞 | ≤ 100/小时 | 避免短时间内大量点赞 |
| 评论 | ≤ 50/小时 | 评论内容需多样化 |
| 关注 | ≤ 10/天 | 避免大量关注 |
| 发帖 | ≤ 2/天 | 避免 spam |

### 账号安全

- ✅ 使用真实账号，避免新号
- ✅ 操作间隔 ≥ 5 秒
- ✅ 评论内容真实、多样化
- ✅ 定期手动登录账号
- ❌ 不要使用代理/IP 切换
- ❌ 不要发布违规内容

---

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

### 开发环境设置

```bash
# 克隆项目
git clone https://github.com/BodaFu/auto-rednote.git

# 安装依赖
npm install

# 链接到 OpenClaw
ln -s $(pwd) ~/.openclaw/skills/auto-rednote

# 运行测试
npm test
```

---

## 📄 License

MIT License - 详见 [LICENSE](LICENSE) 文件

---

## 🔗 相关链接

- [OpenClaw 官方文档](https://docs.openclaw.ai)
- [ClawHub 技能市场](https://clawhub.ai)
- [OpenClaw GitHub](https://github.com/openclaw/openclaw)
- [Discord 社区](https://discord.com/invite/clawd)

---

## 📊 Star History

[![Star History Chart](https://api.star-history.com/svg?repos=BodaFu/auto-rednote&type=Date)](https://star-history.com/#BodaFu/auto-rednote&Date)

---

**最后更新：** 2026-02-27  
**维护者：** [@BodaFu](https://github.com/BodaFu)
