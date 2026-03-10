/**
 * auto-rednote - 小红书自动化运营 OpenClaw Extension
 *
 * 通过复用 openclaw browser 工具（host profile，共享已登录的 Chrome）
 * 实现小红书网页端的完整操作能力。
 *
 * 同时通过 peekaboo CLI 控制小红书桌面 App（iOS on macOS）
 * 实现网页端不支持的私信（IM）操作能力。
 *
 * 工具列表（24个）：
 * 账号工具：
 * - xhs_check_login           检查登录状态
 * - xhs_get_qrcode            获取登录二维码
 * - xhs_my_profile            获取我的主页信息
 * - xhs_my_notes              获取我的笔记列表（含互动数据）
 * 内容工具：
 * - xhs_list_feeds            获取推荐 Feed 列表
 * - xhs_search                搜索内容
 * - xhs_get_feed              获取帖子详情（含评论）
 * - xhs_get_sub_comments      获取子评论列表
 * - xhs_get_user              获取用户主页
 * 互动工具：
 * - xhs_post_comment          发表评论
 * - xhs_reply_comment         回复评论
 * - xhs_like                  点赞 / 取消点赞
 * - xhs_collect               收藏 / 取消收藏
 * - xhs_follow                关注 / 取消关注用户
 * 通知工具：
 * - xhs_get_notifications_pending 获取待处理通知（心跳专用）
 * - xhs_mark_notification     标记通知处理结果
 * - xhs_notification_stats    获取通知状态统计
 * 发布工具：
 * - xhs_publish               发布笔记（图文 / 视频）
 * 桌面 IM 工具（私信 / 群聊，需要 peekaboo + 小红书桌面 App）：
 * - xhs_desktop_im_scan_inbox    【推荐】扫描消息列表 + 返回预计算点击坐标
 * - xhs_desktop_im_scan_stranger 【推荐】扫描陌生人消息列表 + 返回「回复」按钮坐标
 * - xhs_desktop_im_unread        扫描未读私信（兼容旧版）
 * - xhs_desktop_im_inbox         查看消息收件箱（简单截图）
 * - xhs_desktop_im_open          打开指定私信对话（坐标来自 scan 工具）
 * - xhs_desktop_im_send          在当前对话中发送私信
 * - xhs_desktop_im_back          返回上一页
 * - xhs_desktop_im_see           获取当前 UI 元素列表（调试 / 动态定位）
 * - xhs_desktop_screenshot       截图当前小红书桌面 App 界面
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "../../src/plugins/types.js";
import {
  listFeeds,
  searchFeeds,
  getFeed,
  getSubComments,
  getUserProfile,
  getMyProfile,
  getMyNotes,
  followUser,
} from "./src/actions/feeds.js";
import { postComment, replyComment, likeFeed, collectFeed } from "./src/actions/interact.js";
import { checkLoginStatus, getLoginQrcode } from "./src/actions/login.js";
import {
  getNotificationsPending,
  markNotification,
  getNotificationsStats,
} from "./src/actions/notifications.js";
import { publishNote } from "./src/actions/publish.js";
import {
  initState,
  hasCommentedOnFeed,
  recordFeedComment,
  getFeedCommentCount,
} from "./src/state.js";
import {
  scanInbox,
  scanStrangerList,
  scanUnread,
  getInbox,
  openConversation,
  sendMessage,
  navigateBack,
  takeScreenshot,
  getCurrentElements,
} from "./src/desktop/im.js";
import { DEFAULT_PEEKABOO_CONFIG } from "./src/desktop/peekaboo.js";
import { DEFAULT_GHOST_CONFIG, type GhostConfig } from "./src/desktop/ghost.js";
import {
  desktopListFeeds,
  desktopSearch,
  desktopGetFeed,
  desktopGoBack,
} from "./src/actions/desktop-feeds.js";
export default function register(api: OpenClawPluginApi) {
  // 初始化配置
  const pluginCfg = (api.pluginConfig ?? {}) as {
    dbPath?: string;
    browserProfile?: string;
    peekabooPath?: string;
    desktopAppName?: string;
    desktopWindowTitle?: string;
    desktopProcessName?: string;
    /**
     * 操作小红书 App 完成后是否自动切回原前台 App。
     * - true（默认）：个人电脑使用，操作完立刻切回，桌面短暂闪烁约 1-2 秒
     * - false：专用设备部署（无人值守），操作完保持在小红书界面
     */
    desktopRestoreApp?: boolean;
    ghostPath?: string;
    ghostAppName?: string;
  };

  const dbPath = pluginCfg.dbPath;
  const browserProfile = pluginCfg.browserProfile;

  // 桌面端配置（peekaboo）
  const peekabooConfig = {
    ...DEFAULT_PEEKABOO_CONFIG,
    ...(pluginCfg.peekabooPath ? { bin: pluginCfg.peekabooPath } : {}),
    ...(pluginCfg.desktopAppName ? { appName: pluginCfg.desktopAppName } : {}),
    ...(pluginCfg.desktopWindowTitle ? { windowTitle: pluginCfg.desktopWindowTitle } : {}),
    ...(pluginCfg.desktopProcessName ? { processName: pluginCfg.desktopProcessName } : {}),
    // desktopRestoreApp 未配置时使用默认值 true（个人电脑友好模式）
    ...(pluginCfg.desktopRestoreApp !== undefined
      ? { restoreApp: pluginCfg.desktopRestoreApp }
      : {}),
  };

  // 桌面端配置（Ghost OS）
  const ghostConfig: GhostConfig = {
    ...DEFAULT_GHOST_CONFIG,
    ...(pluginCfg.ghostPath ? { bin: pluginCfg.ghostPath } : {}),
    ...(pluginCfg.ghostAppName ? { appName: pluginCfg.ghostAppName } : {}),
  };

  // 初始化 SQLite 状态数据库
  try {
    initState(dbPath);
  } catch (err) {
    api.logger.warn(`auto-rednote: SQLite 初始化失败: ${err}`);
  }

  // ============================================================================
  // 账号工具
  // ============================================================================

  api.registerTool(
    {
      name: "xhs_check_login",
      description: "检查小红书登录状态。返回是否已登录。",
      parameters: Type.Object({}),
      async execute(_id: string, _params: Record<string, unknown>) {
        const result = await checkLoginStatus(browserProfile);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          details: result,
        };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "xhs_get_qrcode",
      description: "获取小红书登录二维码 URL。若已登录则返回 alreadyLoggedIn: true。",
      parameters: Type.Object({}),
      async execute(_id: string, _params: Record<string, unknown>) {
        const result = await getLoginQrcode(browserProfile);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          details: result,
        };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "xhs_my_profile",
      description:
        "获取当前登录账号的小红书主页信息（昵称、简介、互动数据等）。无需参数，自动从登录状态获取。",
      parameters: Type.Object({}),
      async execute(_id: string, _params: Record<string, unknown>) {
        const result = await getMyProfile(browserProfile);
        if (!result) {
          return {
            content: [{ type: "text" as const, text: "未获取到主页信息，请检查登录状态" }],
            details: null,
          };
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "xhs_my_notes",
      description:
        "获取当前登录账号发布的笔记列表，包含每篇笔记的 ID、标题、点赞/收藏/评论数等互动数据。用于追踪内容表现。",
      parameters: Type.Object({}),
      async execute(_id: string, _params: Record<string, unknown>) {
        const notes = await getMyNotes(browserProfile);
        const text = `获取到 ${notes.length} 篇我的笔记`;
        return {
          content: [{ type: "text" as const, text: `${text}\n${JSON.stringify(notes, null, 2)}` }],
          details: { count: notes.length, notes },
        };
      },
    },
    { optional: true },
  );

  // ============================================================================
  // 内容工具
  // ============================================================================

  api.registerTool(
    {
      name: "xhs_list_feeds",
      description:
        "获取小红书首页推荐 Feed 列表。返回笔记列表，包含 id、xsecToken、标题、用户、互动数据。默认返回前 10 条（省 token），可通过 limit 调整。",
      parameters: Type.Object({
        limit: Type.Optional(
          Type.Number({ description: "最大返回数量（默认 10，设为 0 返回全部）" }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const allFeeds = await listFeeds(browserProfile);
        const limit = typeof params.limit === "number" ? params.limit : 10;
        const feeds = limit > 0 ? allFeeds.slice(0, limit) : allFeeds;
        const text =
          feeds.length < allFeeds.length
            ? `获取到 ${allFeeds.length} 条推荐笔记，返回前 ${feeds.length} 条`
            : `获取到 ${feeds.length} 条推荐笔记`;
        return {
          content: [{ type: "text" as const, text: `${text}\n${JSON.stringify(feeds, null, 2)}` }],
          details: { count: feeds.length, total: allFeeds.length, feeds },
        };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "xhs_search",
      description: `搜索小红书内容。支持按排序方式、笔记类型、发布时间、搜索范围筛选。

⚠️ 曝光策略建议：
- 评论引流时优先使用 sortBy="latest" + timeRange="day" 或 "week"，在新鲜帖子下评论更容易被看到
- sortBy="most_liked" 适合找高流量帖子蹭热度，但竞争激烈
- sortBy="most_commented" 适合找讨论活跃的帖子，评论被看到的概率更高`,
      parameters: Type.Object({
        keyword: Type.String({ description: "搜索关键词" }),
        sortBy: Type.Optional(
          Type.Union(
            [
              Type.Literal("general"),
              Type.Literal("latest"),
              Type.Literal("most_liked"),
              Type.Literal("most_commented"),
              Type.Literal("most_collected"),
            ],
            {
              description:
                "排序方式：general（综合，默认）、latest（最新）、most_liked（最多点赞）、most_commented（最多评论）、most_collected（最多收藏）",
            },
          ),
        ),
        noteType: Type.Optional(
          Type.Union([Type.Literal("all"), Type.Literal("video"), Type.Literal("normal")], {
            description: "笔记类型：all（不限，默认）、video（视频）、normal（图文）",
          }),
        ),
        timeRange: Type.Optional(
          Type.Union(
            [
              Type.Literal("all"),
              Type.Literal("day"),
              Type.Literal("week"),
              Type.Literal("half_year"),
            ],
            {
              description:
                "发布时间：all（不限，默认）、day（一天内）、week（一周内）、half_year（半年内）",
            },
          ),
        ),
        searchScope: Type.Optional(
          Type.Union(
            [
              Type.Literal("all"),
              Type.Literal("viewed"),
              Type.Literal("not_viewed"),
              Type.Literal("following"),
            ],
            {
              description:
                "搜索范围：all（不限，默认）、viewed（已看过）、not_viewed（未看过）、following（已关注）",
            },
          ),
        ),
        limit: Type.Optional(
          Type.Number({ description: "最大返回数量，默认 20。建议不超过 50。" }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const keyword = String(params.keyword ?? "");
        if (!keyword.trim()) throw new Error("keyword 不能为空");
        const limit = typeof params.limit === "number" ? Math.max(1, params.limit) : 20;

        const allFeeds = await searchFeeds(
          keyword,
          {
            sortBy: params.sortBy as "general" | "latest" | undefined,
            noteType: params.noteType as "all" | "video" | "normal" | undefined,
            timeRange: params.timeRange as "all" | "day" | "week" | "half_year" | undefined,
            searchScope: params.searchScope as "all" | "viewed" | "not_viewed" | "following" | undefined,
          },
          browserProfile,
        );
        const feeds = allFeeds.slice(0, limit);
        return {
          content: [
            {
              type: "text" as const,
              text: `搜索"${keyword}"找到 ${allFeeds.length} 条结果，返回前 ${feeds.length} 条\n${JSON.stringify(feeds, null, 2)}`,
            },
          ],
          details: { keyword, total: allFeeds.length, count: feeds.length, feeds },
        };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "xhs_get_feed",
      description:
        "获取小红书帖子详情，包含笔记内容和评论列表。⚠️ 注意：comments.hasMore=true 时评论列表不完整（仅首屏），每条评论的 subCommentHasMore=true 时子评论也不完整。不要用此工具的返回结果判断某条评论是否存在——请直接调用 xhs_reply_comment，它有完整的滚动查找和子评论展开能力。",
      parameters: Type.Object({
        feedId: Type.String({ description: "笔记 ID" }),
        xsecToken: Type.String({ description: "xsec_token，从 Feed 列表中获取" }),
        loadAllComments: Type.Optional(
          Type.Boolean({ description: "是否加载所有评论（默认 false，只加载首屏）" }),
        ),
        expandSubComments: Type.Optional(
          Type.Boolean({ description: "是否展开子评论（默认 false）" }),
        ),
        maxCommentPages: Type.Optional(Type.Number({ description: "最大评论翻页数（默认 3）" })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const feedId = String(params.feedId ?? "");
        const xsecToken = String(params.xsecToken ?? "");
        if (!feedId) throw new Error("feedId 不能为空");
        if (!xsecToken) throw new Error("xsecToken 不能为空");

        const result = await getFeed(
          feedId,
          xsecToken,
          {
            loadAllComments: params.loadAllComments === true,
            expandSubComments: params.expandSubComments === true,
            maxCommentPages:
              typeof params.maxCommentPages === "number" ? params.maxCommentPages : 3,
          },
          browserProfile,
        );

        if (!result) {
          return {
            content: [{ type: "text" as const, text: "未找到该笔记，可能已删除或无权访问" }],
            details: null,
          };
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "xhs_get_sub_comments",
      description:
        "获取某条评论下的所有子评论。适用于需要查看完整子评论列表的场景（如查找特定用户的回复）。会自动展开所有「展开更多回复」，最多 30 轮。",
      parameters: Type.Object({
        feedId: Type.String({ description: "笔记 ID" }),
        xsecToken: Type.String({ description: "xsec_token" }),
        parentCommentId: Type.String({ description: "父评论 ID（要展开子评论的那条顶级评论）" }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const feedId = String(params.feedId ?? "");
        const xsecToken = String(params.xsecToken ?? "");
        const parentCommentId = String(params.parentCommentId ?? "");
        if (!feedId) throw new Error("feedId 不能为空");
        if (!xsecToken) throw new Error("xsecToken 不能为空");
        if (!parentCommentId) throw new Error("parentCommentId 不能为空");

        const result = await getSubComments(feedId, xsecToken, parentCommentId, browserProfile);
        const text = result.parentFound
          ? `${result.message}\n${JSON.stringify(result.subComments, null, 2)}`
          : result.message;
        return {
          content: [{ type: "text" as const, text }],
          details: result,
        };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "xhs_get_user",
      description: "获取小红书用户主页信息，包含基本信息、互动数据和发布的笔记列表。",
      parameters: Type.Object({
        userId: Type.String({ description: "用户 ID" }),
        xsecToken: Type.String({ description: "xsec_token" }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const userId = String(params.userId ?? "");
        const xsecToken = String(params.xsecToken ?? "");
        if (!userId) throw new Error("userId 不能为空");
        if (!xsecToken) throw new Error("xsecToken 不能为空");

        const profile = await getUserProfile(userId, xsecToken, browserProfile);
        if (!profile) {
          return {
            content: [{ type: "text" as const, text: "未找到该用户" }],
            details: null,
          };
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify(profile, null, 2) }],
          details: profile,
        };
      },
    },
    { optional: true },
  );

  // ============================================================================
  // 互动工具
  // ============================================================================

  api.registerTool(
    {
      name: "xhs_post_comment",
      description: "在小红书笔记下发表评论。内置防重复机制：同一篇笔记最多评论 1 次，重复调用会被拦截并返回提示。",
      parameters: Type.Object({
        feedId: Type.String({ description: "笔记 ID" }),
        xsecToken: Type.String({ description: "xsec_token" }),
        content: Type.String({ description: "评论内容" }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const feedId = String(params.feedId ?? "");
        const xsecToken = String(params.xsecToken ?? "");
        const content = String(params.content ?? "");
        if (!feedId) throw new Error("feedId 不能为空");
        if (!xsecToken) throw new Error("xsecToken 不能为空");
        if (!content.trim()) throw new Error("content 不能为空");

        if (hasCommentedOnFeed(feedId, dbPath)) {
          const count = getFeedCommentCount(feedId, dbPath);
          return {
            content: [
              {
                type: "text" as const,
                text: `已拦截：你已经评论过这篇笔记 ${count} 次了，跳过重复评论。请换一篇笔记互动。`,
              },
            ],
            details: { blocked: true, feedId, existingComments: count },
          };
        }

        const result = await postComment(feedId, xsecToken, content, browserProfile);
        recordFeedComment(feedId, content, dbPath);
        return {
          content: [{ type: "text" as const, text: result.message }],
          details: result,
        };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "xhs_reply_comment",
      description: "回复小红书笔记中的评论。",
      parameters: Type.Object({
        feedId: Type.String({ description: "笔记 ID" }),
        xsecToken: Type.String({ description: "xsec_token" }),
        commentId: Type.String({ description: "要回复的评论 ID" }),
        content: Type.String({ description: "回复内容" }),
        parentCommentId: Type.Optional(
          Type.String({ description: "父评论 ID（回复子评论时需要）" }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const feedId = String(params.feedId ?? "");
        const xsecToken = String(params.xsecToken ?? "");
        const commentId = String(params.commentId ?? "");
        const content = String(params.content ?? "");
        const parentCommentId = params.parentCommentId ? String(params.parentCommentId) : undefined;

        if (!feedId) throw new Error("feedId 不能为空");
        if (!xsecToken) throw new Error("xsecToken 不能为空");
        if (!commentId) throw new Error("commentId 不能为空");
        if (!content.trim()) throw new Error("content 不能为空");

        const result = await replyComment(
          feedId,
          xsecToken,
          commentId,
          content,
          parentCommentId,
          browserProfile,
        );
        return {
          content: [{ type: "text" as const, text: result.message }],
          details: result,
        };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "xhs_like",
      description: "点赞或取消点赞小红书笔记。",
      parameters: Type.Object({
        feedId: Type.String({ description: "笔记 ID" }),
        xsecToken: Type.String({ description: "xsec_token" }),
        unlike: Type.Optional(Type.Boolean({ description: "true 表示取消点赞（默认 false）" })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const feedId = String(params.feedId ?? "");
        const xsecToken = String(params.xsecToken ?? "");
        const unlike = params.unlike === true;

        if (!feedId) throw new Error("feedId 不能为空");
        if (!xsecToken) throw new Error("xsecToken 不能为空");

        const result = await likeFeed(feedId, xsecToken, unlike, browserProfile);
        return {
          content: [{ type: "text" as const, text: result.message }],
          details: result,
        };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "xhs_collect",
      description: "收藏或取消收藏小红书笔记。",
      parameters: Type.Object({
        feedId: Type.String({ description: "笔记 ID" }),
        xsecToken: Type.String({ description: "xsec_token" }),
        uncollect: Type.Optional(Type.Boolean({ description: "true 表示取消收藏（默认 false）" })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const feedId = String(params.feedId ?? "");
        const xsecToken = String(params.xsecToken ?? "");
        const uncollect = params.uncollect === true;

        if (!feedId) throw new Error("feedId 不能为空");
        if (!xsecToken) throw new Error("xsecToken 不能为空");

        const result = await collectFeed(feedId, xsecToken, uncollect, browserProfile);
        return {
          content: [{ type: "text" as const, text: result.message }],
          details: result,
        };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "xhs_follow",
      description: "关注或取消关注小红书用户。",
      parameters: Type.Object({
        userId: Type.String({ description: "目标用户 ID" }),
        xsecToken: Type.String({ description: "xsec_token（从 Feed 或用户主页获取）" }),
        unfollow: Type.Optional(Type.Boolean({ description: "true 表示取消关注（默认 false）" })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const userId = String(params.userId ?? "");
        const xsecToken = String(params.xsecToken ?? "");
        const unfollow = params.unfollow === true;

        if (!userId) throw new Error("userId 不能为空");
        if (!xsecToken) throw new Error("xsecToken 不能为空");

        const result = await followUser(userId, xsecToken, unfollow, browserProfile);
        return {
          content: [{ type: "text" as const, text: result.message }],
          details: result,
        };
      },
    },
    { optional: true },
  );

  // ============================================================================
  // 通知工具
  // ============================================================================

  api.registerTool(
    {
      name: "xhs_get_notifications_pending",
      description:
        "获取待处理的小红书通知（心跳专用）。自动拉取最新通知并写入 SQLite，返回尚未处理的通知列表。",
      parameters: Type.Object({
        maxPages: Type.Optional(Type.Number({ description: "拉取通知的最大页数（默认 5）" })),
        maxResults: Type.Optional(Type.Number({ description: "最大返回待处理数量（默认 20）" })),
        fullScan: Type.Optional(
          Type.Boolean({ description: "是否全量扫描（默认 false，增量扫描）" }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const result = await getNotificationsPending(
          {
            maxPages: typeof params.maxPages === "number" ? params.maxPages : undefined,
            maxResults: typeof params.maxResults === "number" ? params.maxResults : undefined,
            fullScan: params.fullScan === true,
            dbPath,
          },
          browserProfile,
        );
        const text = `${result.summary}${result.hasMore ? "（还有更多）" : ""}`;
        return {
          content: [{ type: "text" as const, text: `${text}\n${JSON.stringify(result, null, 2)}` }],
          details: result,
        };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "xhs_mark_notification",
      description:
        "标记小红书通知的处理结果（replied/skipped/retry）。用于心跳处理完通知后更新状态。",
      parameters: Type.Object({
        notificationId: Type.String({ description: "通知 ID" }),
        status: Type.Union(
          [Type.Literal("replied"), Type.Literal("skipped"), Type.Literal("retry")],
          { description: "处理状态：replied（已回复）、skipped（已跳过）、retry（需重试）" },
        ),
        replyContent: Type.Optional(
          Type.String({ description: "回复内容（status=replied 时记录）" }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const notificationId = String(params.notificationId ?? "");
        const status = String(params.status ?? "") as "replied" | "skipped" | "retry";
        const replyContent =
          typeof params.replyContent === "string" ? params.replyContent : undefined;

        if (!notificationId) throw new Error("notificationId 不能为空");
        if (!["replied", "skipped", "retry"].includes(status)) throw new Error("status 无效");

        const result = markNotification({ notificationId, status, replyContent, dbPath });
        return {
          content: [{ type: "text" as const, text: result.message }],
          details: result,
        };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "xhs_notification_stats",
      description: "获取小红书通知状态统计（各状态数量汇总）。",
      parameters: Type.Object({}),
      async execute(_id: string, _params: Record<string, unknown>) {
        const result = getNotificationsStats(dbPath);
        return {
          content: [{ type: "text" as const, text: result.summary }],
          details: result,
        };
      },
    },
    { optional: true },
  );

  // ============================================================================
  // 发布工具
  // ============================================================================

  api.registerTool(
    {
      name: "xhs_publish",
      description: "发布小红书笔记（图文或视频）。需要提供本地文件路径。⚠️ 需要 OpenClaw 浏览器环境（运行 `openclaw browser` 启动浏览器后方可使用）。",
      parameters: Type.Object({
        type: Type.Union([Type.Literal("image"), Type.Literal("video")], {
          description: "笔记类型：image（图文）或 video（视频）",
        }),
        title: Type.String({ description: "笔记标题（最多20字）" }),
        content: Type.String({ description: "笔记正文" }),
        mediaPaths: Type.Optional(Type.Array(Type.String(), {
          description:
            "媒体文件的本地路径列表（图文：图片路径数组；视频：视频文件路径数组，只取第一个）。图文类型可不传，发布纯文字笔记",
        })),
        tags: Type.Optional(Type.Array(Type.String(), { description: "标签列表（不含#号）" })),
        scheduleAt: Type.Optional(
          Type.String({ description: "定时发布时间，格式：YYYY-MM-DD HH:mm" }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const type = String(params.type ?? "image") as "image" | "video";
        const title = String(params.title ?? "");
        const content = String(params.content ?? "");
        const mediaPaths = Array.isArray(params.mediaPaths) ? params.mediaPaths.map(String) : [];
        const tags = Array.isArray(params.tags) ? params.tags.map(String) : undefined;
        const scheduleAt = typeof params.scheduleAt === "string" ? params.scheduleAt : undefined;

        if (!title.trim()) throw new Error("title 不能为空");
        if (type === "video" && mediaPaths.length === 0) throw new Error("视频笔记必须提供 mediaPaths");

        const result = await publishNote(
          { type, title, content, mediaPaths, tags, scheduleAt },
          browserProfile,
        );
        const text = result.noteId
          ? `${result.message}（笔记 ID: ${result.noteId}）`
          : result.message;
        return {
          content: [{ type: "text" as const, text: text }],
          details: result,
        };
      },
    },
    { optional: true },
  );

  // ============================================================================
  // 桌面 IM 工具（私信 / 群聊）
  // 依赖：peekaboo CLI + 小红书桌面 App（iOS on macOS）
  // 网页版不支持消息页私信/群聊，必须使用桌面 App 操作。
  // ============================================================================

  api.registerTool(
    {
      name: "xhs_desktop_im_scan_inbox",
      description: `【推荐】扫描小红书消息列表，返回截图 + 所有可见行的预计算点击坐标。

自动导航到「消息」Tab → 截图 → 返回：
- screenshot（图片，1512×949 像素）：消息列表界面
- visibleRows：11 行可见消息的坐标（硬编码），每行包含 clickX/clickY 和 row 编号

**重要：「陌生人消息」入口不在固定位置，它按时间排序混在普通对话中间。**
你必须视觉分析截图，找到「陌生人消息」所在行，使用该行的 clickX/clickY。

**使用流程**：
1. 调用此工具 → 获得截图 + 所有行坐标
2. 视觉分析截图，识别每行内容：
   - 带未读标记（右侧红点/数字）的对话行 → 打开回复
   - 标注「陌生人消息」的行 → 打开进入陌生人列表
3. 用 visibleRows[N].clickX/clickY 调用 xhs_desktop_im_open
4. 进入陌生人列表后 → 调用 xhs_desktop_im_scan_stranger

**坐标必须来自 visibleRows 返回值**，不要从截图中自行估算坐标。`,
      parameters: Type.Object({}),
      async execute(_id: string, _params: Record<string, unknown>) {
        const result = await scanInbox(peekabooConfig);
        const lines = result.visibleRows
          .map((r) => `  第${r.row}行: clickX=${r.clickX}, clickY=${r.clickY}`)
          .join("\n");
        const unreadInfo = result.hasUnread
          ? `AX 树检测到 ${result.unreadBadges.length} 个未读角标: ${result.unreadBadges.map((b) => b.label).join(", ")}`
          : "AX 树未检测到未读角标（仍需视觉确认截图）";
        const summary = [
          `消息列表截图已返回（1512×949 像素，截图坐标=点击坐标）`,
          unreadInfo,
          `可见行坐标（${result.visibleRows.length} 行，包含普通对话和「陌生人消息」入口）：`,
          lines,
          `⚠️ 请视觉分析截图，找到「陌生人消息」在第几行，并找出有未读标记的行。`,
        ].join("\n");
        return {
          content: [
            { type: "text" as const, text: summary },
            {
              type: "image" as const,
              data: result.screenshot.base64,
              mimeType: "image/png" as const,
            },
          ],
          details: {
            visibleRows: result.visibleRows,
            hasUnread: result.hasUnread,
            unreadBadges: result.unreadBadges,
            screenshotPath: result.screenshot.path,
          },
        };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "xhs_desktop_im_scan_stranger",
      description: `扫描陌生人消息列表，返回截图 + 预计算好的「回复」按钮坐标 + 列表是否为空的检测。

**前置条件**：必须已通过 xhs_desktop_im_open 点击「陌生人消息」行的坐标进入陌生人消息列表页。

返回：
- screenshot（图片，1512×949 像素）：陌生人消息列表
- replyButtons：最多 8 个「回复」按钮的坐标
- hasReplyButtons：AX 树检测列表是否有「回复」按钮（辅助判断是否为空）

**使用流程**：
1. 先看 hasReplyButtons 辅助判断，再视觉分析截图确认
2. 如果有消息，用 replyButtons[N].clickX/clickY 调用 xhs_desktop_im_open 打开对话

**坐标必须来自返回值**，不要从截图中自行估算。`,
      parameters: Type.Object({}),
      async execute(_id: string, _params: Record<string, unknown>) {
        const result = await scanStrangerList(peekabooConfig);
        const lines = result.replyButtons
          .map((b) => `  第${b.row}条: clickX=${b.clickX}, clickY=${b.clickY}`)
          .join("\n");
        const listStatus = result.hasReplyButtons
          ? "AX 树检测到「回复」按钮，列表可能有消息"
          : `AX 树未检测到「回复」按钮（${result.axElementCount} 个元素），列表可能为空（仍需视觉确认）`;
        const summary = [
          `陌生人消息列表截图已返回（1512×949 像素）`,
          listStatus,
          `「回复」按钮坐标（${result.replyButtons.length} 条）：`,
          lines,
        ].join("\n");
        return {
          content: [
            { type: "text" as const, text: summary },
            {
              type: "image" as const,
              data: result.screenshot.base64,
              mimeType: "image/png" as const,
            },
          ],
          details: {
            replyButtons: result.replyButtons,
            hasReplyButtons: result.hasReplyButtons,
            screenshotPath: result.screenshot.path,
          },
        };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "xhs_desktop_im_unread",
      description: `扫描未读私信（兼容旧版，推荐使用 xhs_desktop_im_scan_inbox 替代）。

导航到「消息」页，通过 AX 树检测未读角标并截图。
返回 unreadBadges + 截图，但不包含预计算坐标。`,
      parameters: Type.Object({}),
      async execute(_id: string, _params: Record<string, unknown>) {
        const result = await scanUnread(peekabooConfig);
        const summary = result.hasUnread
          ? `检测到 ${result.badgeCount} 个未读角标，消息列表截图已返回，请视觉分析确认具体对话`
          : "当前无未读消息角标（消息列表截图已返回，请视觉确认）";
        return {
          content: [
            { type: "text" as const, text: summary },
            {
              type: "image" as const,
              data: result.screenshot.base64,
              mimeType: "image/png" as const,
            },
          ],
          details: {
            hasUnread: result.hasUnread,
            badgeCount: result.badgeCount,
            unreadBadges: result.unreadBadges,
            screenshotPath: result.screenshot.path,
          },
        };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "xhs_desktop_im_inbox",
      description: `查看消息收件箱（简单截图，不返回坐标）。

导航到「消息」Tab 并截图。推荐使用 xhs_desktop_im_scan_inbox 替代（含坐标）。`,
      parameters: Type.Object({}),
      async execute(_id: string, _params: Record<string, unknown>) {
        const scr = await getInbox(peekabooConfig);
        return {
          content: [
            { type: "text" as const, text: "消息收件箱截图已返回（1512×949 像素）" },
            {
              type: "image" as const,
              data: scr.base64,
              mimeType: "image/png" as const,
            },
          ],
          details: { screenshotPath: scr.path },
        };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "xhs_desktop_im_open",
      description: `打开小红书桌面 App 中的指定私信对话。

支持两种定位方式（二选一）：
- elemId：从 xhs_desktop_im_see 的元素 ID（最稳定）
- x + y：从 xhs_desktop_im_scan_inbox 或 xhs_desktop_im_scan_stranger 返回的 clickX/clickY

**重要：坐标必须来自 scan 工具返回的 clickX/clickY，不要从截图中自行估算坐标。**
截图尺寸为 1512×949 逻辑像素，坐标系与点击坐标一致。

打开后返回对话截图，Agent 需视觉分析读取消息内容。`,
      parameters: Type.Object({
        elemId: Type.Optional(
          Type.String({
            description:
              "元素 ID（来自 xhs_desktop_im_unread.unreadBadges 或 xhs_desktop_im_see），优先使用",
          }),
        ),
        x: Type.Optional(
          Type.Number({
            description: "点击坐标 X（截图像素坐标，elemId 不可用时使用）",
          }),
        ),
        y: Type.Optional(
          Type.Number({
            description: "点击坐标 Y（截图像素坐标，elemId 不可用时使用）",
          }),
        ),
        waitMs: Type.Optional(
          Type.Number({ description: "点击后等待页面加载的毫秒数（默认 1200）" }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const elemId = typeof params.elemId === "string" ? params.elemId : undefined;
        const x = typeof params.x === "number" ? params.x : undefined;
        const y = typeof params.y === "number" ? params.y : undefined;
        const waitMs = typeof params.waitMs === "number" ? params.waitMs : 1200;

        if (!elemId && (x === undefined || y === undefined)) {
          throw new Error("必须提供 elemId 或 (x, y) 坐标之一");
        }

        const result = await openConversation({ elemId, x, y }, peekabooConfig, waitMs);
        const locDesc = result.clickedAt
          ? `点击位置 (${result.clickedAt.x}, ${result.clickedAt.y})`
          : "已点击";
        return {
          content: [
            { type: "text" as const, text: `对话已打开（${locDesc}），截图已返回，请视觉分析消息内容` },
            {
              type: "image" as const,
              data: result.screenshot.base64,
              mimeType: "image/png" as const,
            },
          ],
          details: {
            clickedAt: result.clickedAt,
            screenshotPath: result.screenshot.path,
          },
        };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "xhs_desktop_im_send",
      description: `在小红书桌面 App 当前打开的私信对话中发送一条消息。

前置条件：必须已通过 xhs_desktop_im_open 打开了某个对话（底部输入框可见）。
发送流程：点击输入框 → 输入文字 → 按 Return 发送。
返回文字确认（不返回截图，节省 token），如需确认可调用 xhs_desktop_screenshot。`,
      parameters: Type.Object({
        text: Type.String({ description: "要发送的消息内容（支持中文）" }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const text = String(params.text ?? "").trim();
        if (!text) throw new Error("text 不能为空");

        const result = await sendMessage(text, peekabooConfig);
        return {
          content: [
            {
              type: "text" as const,
              text: `消息已发送：「${result.sentText.slice(0, 50)}${result.sentText.length > 50 ? "…" : ""}」（${result.charCount} 字）`,
            },
          ],
          details: {
            sentText: result.sentText,
            charCount: result.charCount,
          },
        };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "xhs_desktop_im_back",
      description: `在小红书桌面 App 中点击返回按钮（左上角 <）导航到上一页。
用于从对话页返回消息列表，或从消息列表返回到首页。
返回文字确认（不返回截图，节省 token）。`,
      parameters: Type.Object({}),
      async execute(_id: string, _params: Record<string, unknown>) {
        const result = await navigateBack(peekabooConfig);
        return {
          content: [
            { type: "text" as const, text: `已点击返回按钮 (${result.clickedAt.x},${result.clickedAt.y})，已导航到上一页` },
          ],
          details: result,
        };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "xhs_desktop_im_see",
      description: `获取小红书桌面 App 当前界面的 UI 可交互元素列表（含截图）。

返回：
- 截图（当前界面）
- elements：所有 UI 元素（含角色、标签、是否可交互）
- interactableElements：仅可交互元素

主要用途：
1. 查找未读角标的 elemId（如"2条未读"的 elem_8），用于 xhs_desktop_im_open
2. 调试当前 App 状态
3. 验证当前是否在正确页面

注意：小红书 iOS App 的 AX 树质量较低，多数元素 label 为"按钮"/"文本"，
有意义的标签通常是导航角标（"X条未读"）。`,
      parameters: Type.Object({}),
      async execute(_id: string, _params: Record<string, unknown>) {
        const result = await getCurrentElements(peekabooConfig);
        const summary =
          `共 ${result.elementCount} 个元素，${result.interactableCount} 个可交互。` +
          (result.interactableElements.filter((e) => e.label && !["按钮", "文本", "组", "标题"].includes(e.label)).length > 0
            ? `\n有意义的元素：${result.interactableElements.filter((e) => e.label && !["按钮", "文本", "组", "标题"].includes(e.label)).map((e) => `${e.id}(${e.label})`).join(", ")}`
            : "");
        return {
          content: [
            { type: "text" as const, text: summary },
            {
              type: "image" as const,
              data: result.screenshot.base64,
              mimeType: "image/png" as const,
            },
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  snapshotId: result.snapshotId,
                  interactableElements: result.interactableElements.map((e) => ({
                    id: e.id,
                    role: e.role,
                    label: e.label,
                    description: e.description,
                  })),
                },
                null,
                2,
              ),
            },
          ],
          details: {
            snapshotId: result.snapshotId,
            elementCount: result.elementCount,
            interactableCount: result.interactableCount,
            interactableElements: result.interactableElements,
            screenshotPath: result.screenshot.path,
          },
        };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "xhs_desktop_screenshot",
      description: `截图小红书桌面 App 当前界面（1512×949 像素）。
适用于：确认当前页面状态、调试交互结果、在不需要完整 IM 流程时快速查看界面。
截图已缩放到逻辑像素尺寸，像素坐标与点击坐标一致。`,
      parameters: Type.Object({}),
      async execute(_id: string, _params: Record<string, unknown>) {
        const scr = await takeScreenshot(peekabooConfig);
        return {
          content: [
            { type: "text" as const, text: `截图已返回（路径: ${scr.path}）` },
            {
              type: "image" as const,
              data: scr.base64,
              mimeType: "image/png" as const,
            },
          ],
          details: { screenshotPath: scr.path },
        };
      },
    },
    { optional: true },
  );

  // ============================================================================
  // 桌面端 Feed 工具（Ghost OS）
  // 通过 GUI 操作小红书 macOS App，替代网页端 CDP 操作，降低风控风险。
  // 数据通过 AX 树深度遍历提取，不依赖网页端 __INITIAL_STATE__。
  // ============================================================================

  api.registerTool(
    {
      name: "xhs_desktop_list_feeds",
      description: `获取小红书桌面 App 首页推荐 Feed 列表。

通过 Ghost OS 操作小红书 macOS App（非网页端），从 AX 树提取 Feed 卡片信息。
返回笔记标题、作者、点赞数等。同时返回截图用于视觉确认。

⚠️ 与网页端 xhs_list_feeds 的区别：
- 无 feedId/xsecToken（桌面端无法获取内部 ID）
- 数据来自 AX 树文本提取，可能不如网页端完整
- 操作通过 GUI 完成，更像真人行为，风控风险更低
- 需要小红书 macOS App 在本地运行`,
      parameters: Type.Object({}),
      async execute(_id: string, _params: Record<string, unknown>) {
        const result = await desktopListFeeds(ghostConfig);
        const summary = `从桌面 App 获取到 ${result.items.length} 条推荐笔记`;
        const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
          { type: "text" as const, text: `${summary}\n${JSON.stringify(result.items, null, 2)}` },
        ];
        if (result.screenshot) {
          content.push({
            type: "image" as const,
            data: result.screenshot.base64,
            mimeType: result.screenshot.mimeType,
          });
        }
        return {
          content,
          details: {
            count: result.items.length,
            items: result.items,
            rawText: result.rawText,
          },
        };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "xhs_desktop_search",
      description: `在小红书桌面 App 中搜索内容。

通过 Ghost OS 操作小红书 macOS App 的搜索功能，输入关键词并提取搜索结果。
返回内容摘要、作者、发布时间、点赞数等。同时返回截图用于视觉确认。

⚠️ 与网页端 xhs_search 的区别：
- 不支持排序/筛选参数（需要额外 GUI 操作实现）
- 无 feedId/xsecToken
- 操作通过 GUI 完成，风控风险更低
- 需要小红书 macOS App 在本地运行`,
      parameters: Type.Object({
        keyword: Type.String({ description: "搜索关键词" }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const keyword = String(params.keyword ?? "");
        if (!keyword.trim()) throw new Error("keyword 不能为空");

        const result = await desktopSearch(keyword, ghostConfig);
        const summary = `桌面 App 搜索"${keyword}"找到 ${result.items.length} 条结果`;
        const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
          { type: "text" as const, text: `${summary}\n${JSON.stringify(result.items, null, 2)}` },
        ];
        if (result.screenshot) {
          content.push({
            type: "image" as const,
            data: result.screenshot.base64,
            mimeType: result.screenshot.mimeType,
          });
        }
        return {
          content,
          details: {
            keyword,
            count: result.items.length,
            items: result.items,
            rawText: result.rawText,
          },
        };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "xhs_desktop_get_feed",
      description: `获取小红书桌面 App 中的帖子详情。

通过标题文本在当前页面中查找并点击目标帖子，进入详情页后提取内容。
返回 AX 树原始文本（包含标题、正文、评论等）+ 截图。

⚠️ 使用前提：
- 当前页面必须有目标帖子可见（首页 Feed 或搜索结果页）
- 通过 titleQuery 参数匹配帖子标题（模糊匹配）
- 查看完毕后调用 xhs_desktop_go_back 返回列表页

⚠️ 与网页端 xhs_get_feed 的区别：
- 通过标题文本定位，而非 feedId
- 返回 AX 树原始文本，需要 Agent 自行解析
- 评论数据可能不完整（AX 树限制）`,
      parameters: Type.Object({
        titleQuery: Type.String({ description: "帖子标题（或标题中的关键词，用于模糊匹配）" }),
        scrollForComments: Type.Optional(
          Type.Boolean({ description: "是否滚动加载评论（默认 true）" }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const titleQuery = String(params.titleQuery ?? "");
        if (!titleQuery.trim()) throw new Error("titleQuery 不能为空");

        const scrollForComments = params.scrollForComments !== false;
        const result = await desktopGetFeed(titleQuery, ghostConfig, { scrollForComments });
        const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
          { type: "text" as const, text: result.rawText },
        ];
        if (result.screenshot) {
          content.push({
            type: "image" as const,
            data: result.screenshot.base64,
            mimeType: result.screenshot.mimeType,
          });
        }
        return {
          content,
          details: { titleQuery, rawText: result.rawText },
        };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "xhs_desktop_go_back",
      description: `在小红书桌面 App 中返回上一页。点击左上角返回按钮。
用于从帖子详情页返回列表页，或从搜索结果返回首页。`,
      parameters: Type.Object({}),
      async execute(_id: string, _params: Record<string, unknown>) {
        await desktopGoBack(ghostConfig);
        return {
          content: [{ type: "text" as const, text: "已返回上一页" }],
          details: {},
        };
      },
    },
    { optional: true },
  );
}
