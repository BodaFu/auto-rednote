/**
 * notifications.ts - 获取小红书通知
 *
 * 通知获取策略：
 * 1. 导航到 /notification 页面
 * 2. 使用 waitForResponseBody 拦截 /api/sns/web/v1/you/mentions* API 响应
 * 3. 解析通知数据并分类
 * 4. 支持分页（通过滚动触发下一页）
 */

import { navigateWithWarmup, evaluate, waitForResponseBody, act, sleep } from "../browser.js";
import {
  upsertNotifications,
  getPendingNotifications,
  updateNotificationStatus,
  getNotificationStats,
} from "../state.js";
import type { XhsNotification, XhsNotificationType, NotificationStatus } from "../types.js";

const XHS_NOTIFICATION_URL = "https://www.xiaohongshu.com/notification";
const MENTIONS_API_PATTERN = "*/api/sns/web/v1/you/mentions*";

// ============================================================================
// 获取通知列表
// ============================================================================

export interface GetNotificationsOptions {
  maxPages?: number;
  sinceTime?: number;
  limit?: number;
}

export interface GetNotificationsResult {
  notifications: XhsNotification[];
  hasMore: boolean;
  nextCursor?: string;
}

export async function getNotifications(
  opts?: GetNotificationsOptions,
  profile?: string,
): Promise<GetNotificationsResult> {
  const maxPages = opts?.maxPages ?? 1;
  const sinceTime = opts?.sinceTime;
  const limit = opts?.limit ?? 50;

  // 先确保 tab 存在并在小红书主页（SPA 预热），
  // 然后在导航前注册拦截器，再触发 reload，确保不错过 API 响应。
  const { targetId } = await navigateWithWarmup(XHS_NOTIFICATION_URL, profile);

  const allNotifications: XhsNotification[] = [];
  let hasMore = false;
  let nextCursor: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    // 关键：先注册拦截，再触发 reload/导航，确保不错过 API 响应
    // waitForResponseBody 内部通过 page.on("response") 监听，必须在请求发出前注册
    const responsePromise = waitForResponseBody(
      targetId,
      MENTIONS_API_PATTERN,
      20000,
      profile,
    ).catch(() => null);

    if (page === 0) {
      // 第一页：强制 reload 丢弃 SPA 缓存，触发 mentions API 请求
      await evaluate(targetId, `() => { window.location.reload(); }`, profile);
    } else {
      // 后续页：滚动到底部触发懒加载（下一页）
      await evaluate(targetId, `() => window.scrollTo(0, document.body.scrollHeight)`, profile);
    }

    // 等待 API 响应（拦截器已提前注册）
    const apiResponse = await responsePromise;
    const responseBody = apiResponse?.body ?? null;

    if (!responseBody) {
      if (page === 0) {
        // 第一页失败，降级到 DOM 提取
        const domNotifications = await extractNotificationsFromDom(targetId, profile);
        allNotifications.push(...domNotifications);
      }
      break;
    }

    const parsed = parseNotificationsResponse(responseBody);
    if (!parsed) break;

    const pageNotifications = parsed.notifications;

    // 时间过滤
    const filtered = sinceTime
      ? pageNotifications.filter((n) => !n.time || n.time > sinceTime)
      : pageNotifications;

    allNotifications.push(...filtered);
    hasMore = parsed.hasMore;
    nextCursor = parsed.cursor;

    // 如果已达到 limit 或没有更多，停止
    if (allNotifications.length >= limit || !hasMore) break;

    // 如果时间过滤导致提前结束（所有通知都早于 sinceTime）
    if (sinceTime && filtered.length < pageNotifications.length) break;

    // 翻页前等待页面稳定
    await sleep(1000);
  }

  return {
    notifications: allNotifications.slice(0, limit),
    hasMore,
    nextCursor,
  };
}

// ============================================================================
// 解析 API 响应
// ============================================================================

interface ParsedNotificationsResponse {
  notifications: XhsNotification[];
  hasMore: boolean;
  cursor?: string;
}

function parseNotificationsResponse(body: string): ParsedNotificationsResponse | null {
  try {
    const data = JSON.parse(body) as {
      code?: number;
      success?: boolean;
      data?: {
        message_list?: unknown[];
        has_more?: boolean;
        strCursor?: string;
        cursor?: number;
      };
    };

    if (!data.success && data.code !== 0) return null;
    if (!data.data) return null;

    const messageList = data.data.message_list ?? [];
    const notifications = messageList
      .map(parseMentionMessage)
      .filter((n): n is XhsNotification => n !== null);

    return {
      notifications,
      hasMore: data.data.has_more ?? false,
      cursor: data.data.strCursor,
    };
  } catch {
    return null;
  }
}

function parseMentionMessage(raw: unknown): XhsNotification | null {
  if (!raw || typeof raw !== "object") return null;
  const msg = raw as Record<string, unknown>;

  const id = String(msg.id ?? msg.notificationId ?? "");
  if (!id) return null;

  // 过滤不支持的通知类型
  const rawType = String(msg.type ?? "");
  if (
    rawType !== "comment/item" &&
    rawType !== "comment/comment" &&
    rawType !== "mention/comment"
  ) {
    return null;
  }

  // 解析通知类型
  const type = parseNotificationType(msg);

  // 解析用户信息
  const userInfo = parseUserInfo(msg.user_info ?? msg.userInfo);

  // 解析评论信息（字段名：comment_info）
  const commentInfo = parseCommentInfo(msg.comment_info ?? msg.commentInfo);

  // 解析帖子信息（字段名：item_info，不是 note_info）
  const itemInfo = parseItemInfo(msg.item_info ?? msg.itemInfo ?? msg.note_info ?? msg.noteInfo);

  // parentCommentId：comment/comment 类型时，target_comment.id 即为父评论 ID
  let parentCommentId: string | undefined;
  if (rawType === "comment/comment") {
    const commentInfoRaw = msg.comment_info as Record<string, unknown> | undefined;
    const targetComment = commentInfoRaw?.target_comment as Record<string, unknown> | undefined;
    if (targetComment?.id) {
      parentCommentId = String(targetComment.id);
    }
  }

  return {
    id,
    type,
    title: typeof msg.title === "string" ? msg.title : undefined,
    time:
      typeof msg.time === "number"
        ? msg.time
        : typeof msg.timestamp === "number"
          ? msg.timestamp
          : undefined,
    userInfo,
    commentInfo,
    itemInfo,
    parentCommentId,
  };
}

function parseNotificationType(msg: Record<string, unknown>): XhsNotificationType {
  const type = String(msg.type ?? "");

  // 精确匹配小红书通知类型
  switch (type) {
    case "comment/item":
      // 有人直接评论了你的笔记（顶级评论）
      return "comment_on_my_note";
    case "comment/comment": {
      // 有人在你的评论下留言：判断是直接回复还是 @他人
      const commentInfoRaw = msg.comment_info as Record<string, unknown> | undefined;
      const content = String(commentInfoRaw?.content ?? "");
      // 评论内容以 @ 开头 → 用户在你的评论下 @了其他人
      if (content.startsWith("@")) return "at_others_under_my_comment";
      return "reply_to_my_comment";
    }
    case "mention/comment":
      // 有人在评论中直接 @了你
      return "mentioned_me";
    default:
      return "unknown";
  }
}

function parseUserInfo(raw: unknown) {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  // 小红书 API user_info 字段：userid（注意不是 user_id）、nickname、image
  return {
    userId: String(u.userid ?? u.user_id ?? u.userId ?? ""),
    nickname: String(u.nickname ?? ""),
    avatar:
      typeof u.image === "string" ? u.image : typeof u.avatar === "string" ? u.avatar : undefined,
    indicator: undefined,
  };
}

function parseCommentInfo(raw: unknown) {
  if (!raw || typeof raw !== "object") return undefined;
  const c = raw as Record<string, unknown>;
  // 小红书 API comment_info 字段：id（评论ID）、content（评论内容）
  const id = String(c.id ?? c.comment_id ?? "");
  if (!id) return undefined;
  return {
    id,
    content: String(c.content ?? c.comment_content ?? ""),
    targetComment: parseTargetComment(c.target_comment ?? c.targetComment),
  };
}

function parseTargetComment(raw: unknown) {
  if (!raw || typeof raw !== "object") return undefined;
  const t = raw as Record<string, unknown>;
  // 小红书 API target_comment 字段：id、content、user_info
  const id = String(t.id ?? t.comment_id ?? "");
  if (!id) return undefined;
  const userInfo = t.user_info as Record<string, unknown> | undefined;
  return {
    id,
    content: String(t.content ?? t.comment_content ?? ""),
    userId: String(userInfo?.userid ?? userInfo?.user_id ?? t.user_id ?? t.userId ?? ""),
  };
}

function parseItemInfo(raw: unknown) {
  if (!raw || typeof raw !== "object") return undefined;
  const i = raw as Record<string, unknown>;
  // 小红书 API item_info 字段：id（笔记ID）、content（标题/摘要）、image（封面）、xsec_token
  const id = String(i.id ?? i.note_id ?? i.noteId ?? "");
  if (!id) return undefined;
  return {
    id,
    content:
      typeof i.content === "string"
        ? i.content
        : typeof i.note_content === "string"
          ? i.note_content
          : undefined,
    image:
      typeof i.image === "string"
        ? i.image
        : typeof i.note_cover_image === "string"
          ? i.note_cover_image
          : undefined,
    xsecToken: typeof i.xsec_token === "string" ? i.xsec_token : undefined,
  };
}

// ============================================================================
// DOM 降级提取（当 API 拦截失败时）
// ============================================================================

async function extractNotificationsFromDom(
  targetId: string,
  profile?: string,
): Promise<XhsNotification[]> {
  const raw = await evaluate(
    targetId,
    `() => {
      const items = [];
      document.querySelectorAll('.notification-item, [class*="notification-item"], .message-item').forEach((el, idx) => {
        const avatar = el.querySelector('img.avatar, .user-avatar img');
        const nickname = el.querySelector('.nickname, .user-name, [class*="nickname"]');
        const content = el.querySelector('.content, .comment-content, [class*="content"]');
        const time = el.querySelector('.time, [class*="time"]');
        items.push({
          id: el.getAttribute('data-id') || el.id || String(idx),
          nickname: nickname ? nickname.textContent?.trim() : '',
          content: content ? content.textContent?.trim() : '',
          time: time ? time.textContent?.trim() : '',
          avatar: avatar ? avatar.src : '',
        });
      });
      return JSON.stringify(items);
    }`,
    profile,
  );

  if (typeof raw !== "string") return [];

  try {
    const items = JSON.parse(raw) as Array<{
      id: string;
      nickname: string;
      content: string;
      time: string;
      avatar: string;
    }>;

    return items.map((item) => ({
      id: item.id,
      type: "unknown" as XhsNotificationType,
      userInfo: item.nickname
        ? { userId: "", nickname: item.nickname, avatar: item.avatar || undefined }
        : undefined,
      commentInfo: item.content ? { id: item.id, content: item.content } : undefined,
    }));
  } catch {
    return [];
  }
}

// ============================================================================
// 获取待处理通知（心跳专用，对应 notifications_get_pending）
//
// 策略：
// 1. 拉取最新通知（支持多页）
// 2. 将新通知写入 SQLite（已存在的自动忽略）
// 3. 从 SQLite 返回 pending/retry 状态的通知
// ============================================================================

export interface PendingNotification {
  notificationId: string;
  relationType: XhsNotificationType;
  retryReason: "" | "timeout" | "deleted_recheck";
  commentId?: string;
  parentCommentId?: string;
  userId?: string;
  userNickname?: string;
  feedId?: string;
  xsecToken?: string;
  noteTitle?: string;
  commentContent?: string;
}

export interface GetPendingOptions {
  maxPages?: number;
  fullScan?: boolean;
  maxResults?: number;
  dbPath?: string;
}

export async function getNotificationsPending(
  opts?: GetPendingOptions,
  profile?: string,
): Promise<{
  pending: PendingNotification[];
  hasMore: boolean;
  summary: string;
}> {
  const maxPages = opts?.maxPages ?? 5;
  const fullScan = opts?.fullScan ?? false;
  const maxResults = opts?.maxResults ?? 20;
  const dbPath = opts?.dbPath;

  // 拉取最新通知并写入 SQLite
  const fetchResult = await getNotifications({ maxPages, limit: maxPages * 20 }, profile);
  const fetched = fetchResult.notifications;

  // 在写入前先记录已存在的 ID，用于计算真正新增的数量
  const existingIds = new Set(getPendingNotifications(9999, dbPath).map((r) => r.id));

  if (fetched.length > 0) {
    upsertNotifications(fetched, dbPath);
  }

  // 从 SQLite 读取待处理通知
  const pendingRecords = getPendingNotifications(maxResults + 10, dbPath);

  const pending: PendingNotification[] = [];
  for (const record of pendingRecords) {
    if (pending.length >= maxResults) break;

    // 只有 pending 和 retry 状态才返回
    if (record.status !== "pending" && record.status !== "retry") continue;

    let rawData: Record<string, unknown>;
    try {
      rawData = JSON.parse(record.notification) as Record<string, unknown>;
    } catch {
      continue;
    }

    const retryReason: "" | "timeout" | "deleted_recheck" =
      record.status === "retry" ? "timeout" : "";

    // 兼容两种存储格式：
    // 新格式（XhsNotification）：嵌套的 itemInfo/commentInfo/userInfo
    // 旧格式（扁平化）：直接的 feedId/commentId/xsecToken/userId 等字段
    const notification = rawData as XhsNotification & Record<string, unknown>;
    const isNewFormat = !!(
      notification.itemInfo ||
      notification.commentInfo ||
      notification.userInfo
    );

    let feedId: string | undefined;
    let xsecToken: string | undefined;
    let commentId: string | undefined;
    let parentCommentId: string | undefined;
    let userId: string | undefined;
    let userNickname: string | undefined;
    let noteTitle: string | undefined;
    let commentContent: string | undefined;
    let relationType = notification.type;

    if (isNewFormat) {
      feedId = notification.itemInfo?.id;
      xsecToken = notification.itemInfo?.xsecToken;
      commentId = notification.commentInfo?.id;
      parentCommentId = notification.parentCommentId;
      userId = notification.userInfo?.userId;
      userNickname = notification.userInfo?.nickname;
      noteTitle = notification.itemInfo?.content;
      commentContent = notification.commentInfo?.content;
    } else {
      // 旧格式：字段直接在顶层
      feedId = typeof rawData.feedId === "string" ? rawData.feedId : undefined;
      xsecToken = typeof rawData.xsecToken === "string" ? rawData.xsecToken : undefined;
      commentId = typeof rawData.commentId === "string" ? rawData.commentId : undefined;
      parentCommentId =
        typeof rawData.parentCommentId === "string" ? rawData.parentCommentId : undefined;
      userId = typeof rawData.userId === "string" ? rawData.userId : undefined;
      userNickname = typeof rawData.userName === "string" ? rawData.userName : undefined;
      noteTitle = typeof rawData.content === "string" ? rawData.content : undefined;
      commentContent = typeof rawData.content === "string" ? rawData.content : undefined;
      // 旧格式的 type 字段可能是已经转换过的 relationType
      if (!relationType || relationType === "unknown") {
        relationType = (
          typeof rawData.type === "string" ? rawData.type : "unknown"
        ) as XhsNotificationType;
      }
    }

    pending.push({
      notificationId: record.id,
      relationType: relationType ?? "unknown",
      retryReason,
      commentId,
      parentCommentId,
      userId,
      userNickname,
      feedId,
      xsecToken,
      noteTitle,
      commentContent,
    });
  }

  const hasMore = pending.length >= maxResults;
  const newCount = fetched.filter((n) => !existingIds.has(n.id)).length;
  const summary = `扫描完成：${fetched.length} 条通知，新增 ${newCount} 条，待处理 ${pending.length} 条`;

  return { pending, hasMore, summary };
}

// ============================================================================
// 标记通知处理结果（对应 notifications_mark_result）
// ============================================================================

export interface MarkNotificationParams {
  notificationId: string;
  status: NotificationStatus;
  replyContent?: string;
  dbPath?: string;
}

export function markNotification(params: MarkNotificationParams): {
  success: boolean;
  message: string;
} {
  try {
    updateNotificationStatus(
      params.notificationId,
      params.status,
      params.replyContent,
      params.dbPath,
    );
    return { success: true, message: `通知 ${params.notificationId} 已标记为 ${params.status}` };
  } catch (err) {
    return {
      success: false,
      message: `标记失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ============================================================================
// 通知状态统计（对应 notifications_stats）
// ============================================================================

export function getNotificationsStats(dbPath?: string): {
  stats: Record<NotificationStatus, number>;
  summary: string;
} {
  const stats = getNotificationStats(dbPath);
  const total = Object.values(stats).reduce((a, b) => a + b, 0);
  const summary = `总计 ${total} 条 | pending: ${stats.pending} | replied: ${stats.replied} | skipped: ${stats.skipped} | retry: ${stats.retry}`;
  return { stats, summary };
}
