// ============================================================================
// 小红书数据类型定义
// ============================================================================

export interface XhsUser {
  userId: string;
  nickname: string;
  avatar?: string;
  redId?: string;
}

export interface XhsInteractInfo {
  likedCount?: string;
  collectedCount?: string;
  commentCount?: string;
  shareCount?: string;
  liked?: boolean;
  collected?: boolean;
}

export interface XhsCover {
  url?: string;
  urlDefault?: string;
  height?: number;
  width?: number;
}

export interface XhsNoteCard {
  type: "normal" | "video";
  displayTitle?: string;
  user?: XhsUser;
  interactInfo?: XhsInteractInfo;
  cover?: XhsCover;
}

export interface XhsFeed {
  id: string;
  xsecToken: string;
  modelType?: string;
  noteCard?: XhsNoteCard;
}

// Feed 详情
export interface XhsImageInfo {
  url?: string;
  urlDefault?: string;
  height?: number;
  width?: number;
}

export interface XhsFeedDetail {
  noteId: string;
  xsecToken?: string;
  title?: string;
  desc?: string;
  type?: "normal" | "video";
  time?: number;
  ipLocation?: string;
  user?: XhsUser;
  interactInfo?: XhsInteractInfo;
  imageList?: XhsImageInfo[];
  video?: {
    media?: {
      stream?: {
        h264?: Array<{ masterUrl?: string }>;
      };
    };
  };
}

// 评论
export interface XhsSubComment {
  id: string;
  content: string;
  userId: string;
  userInfo?: XhsUser;
  createTime?: number;
  ipLocation?: string;
  likeCount?: number;
  liked?: boolean;
}

export interface XhsComment {
  id: string;
  content: string;
  userId: string;
  userInfo?: XhsUser;
  createTime?: number;
  ipLocation?: string;
  likeCount?: number;
  liked?: boolean;
  subComments?: XhsSubComment[];
  subCommentCount?: number;
  subCommentCursor?: string;
  subCommentHasMore?: boolean;
}

export interface XhsCommentList {
  list: XhsComment[];
  cursor?: string;
  hasMore?: boolean;
  totalCount?: number;
}

// 用户主页
export interface XhsUserInteraction {
  type: string;
  name: string;
  count: string;
}

export interface XhsUserProfile {
  basicInfo: {
    userId: string;
    nickname: string;
    avatar?: string;
    redId?: string;
    desc?: string;
    gender?: number;
    ipLocation?: string;
  };
  interactions?: XhsUserInteraction[];
  feeds?: XhsFeed[];
}

// 我的笔记
export interface MyNote {
  noteId: string;
  xsecToken?: string;
  title?: string;
  type?: "normal" | "video";
  time?: number;
  interactInfo?: XhsInteractInfo;
  cover?: XhsCover;
}

// 通知
export type XhsNotificationType =
  | "comment_on_my_note"
  | "reply_to_my_comment"
  | "at_others_under_my_comment"
  | "mentioned_me"
  | "unknown";

export interface XhsNotificationUserInfo {
  userId: string;
  nickname: string;
  avatar?: string;
  indicator?: boolean;
}

export interface XhsNotificationCommentInfo {
  id: string;
  content: string;
  targetComment?: {
    id: string;
    content: string;
    userId: string;
  };
}

export interface XhsNotificationItemInfo {
  id: string;
  content?: string;
  image?: string;
  xsecToken?: string;
  userInfo?: XhsUser;
}

export interface XhsNotification {
  id: string;
  type: XhsNotificationType;
  title?: string;
  time?: number;
  userInfo?: XhsNotificationUserInfo;
  commentInfo?: XhsNotificationCommentInfo;
  itemInfo?: XhsNotificationItemInfo;
  parentCommentId?: string;
}

// 通知状态（SQLite 持久化）
export type NotificationStatus = "pending" | "replied" | "skipped" | "retry";

export interface NotificationRecord {
  id: string;
  status: NotificationStatus;
  notification: string;
  replyContent?: string;
  createdAt: number;
  updatedAt: number;
}

// Browser HTTP API 响应类型
export interface BrowserTab {
  targetId: string;
  title: string;
  url: string;
  wsUrl?: string;
  type?: string;
}

export interface BrowserActResponse {
  ok: true;
  targetId: string;
  url?: string;
  result?: unknown;
}

export interface BrowserNavigateResponse {
  ok: true;
  targetId: string;
  url?: string;
}

export interface BrowserSnapshotResponse {
  ok: true;
  format: "ai" | "aria";
  targetId: string;
  url: string;
  snapshot?: string;
  nodes?: Array<{
    ref: string;
    role: string;
    name: string;
    value?: string;
    depth: number;
  }>;
  refs?: Record<string, { role: string; name?: string; nth?: number }>;
}

// 工具返回结构
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
}
