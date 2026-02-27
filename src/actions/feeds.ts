/**
 * feeds.ts - 内容获取：推荐流、搜索、帖子详情、用户主页
 */

import {
  navigateWithWarmup,
  navigate,
  getOrCreateXhsTab,
  closeTab,
  openTab,
  evaluate,
  extractInitialState,
  waitForInitialState,
  waitForResponseBody,
  act,
  sleep,
  snapshot,
  smartScroll,
} from "../browser.js";
import type {
  XhsFeed,
  XhsFeedDetail,
  XhsCommentList,
  XhsComment,
  XhsSubComment,
  XhsUserProfile,
  MyNote,
} from "../types.js";

const XHS_HOME = "https://www.xiaohongshu.com";

// ============================================================================
// 推荐 Feed 列表
// ============================================================================

export async function listFeeds(profile?: string): Promise<XhsFeed[]> {
  const { targetId } = await navigateWithWarmup(XHS_HOME, profile);

  // 等待推荐流数据
  const data = await waitForInitialState(targetId, "feed.feeds", 10000, profile);
  if (!data) {
    // 降级：等待页面稳定后重试
    await sleep(2000);
    const retryData = await extractInitialState(targetId, "feed.feeds", profile);
    if (!retryData) return [];
    return parseFeedList(retryData);
  }
  return parseFeedList(data);
}

function parseFeedList(raw: unknown): XhsFeed[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => item != null && typeof item === "object")
    .map((item) => ({
      id: String(item.id ?? item.noteId ?? ""),
      xsecToken: String(item.xsecToken ?? item.xsec_token ?? ""),
      modelType: typeof item.modelType === "string" ? item.modelType : undefined,
      noteCard: parseNoteCard(item.noteCard ?? item.note_card),
    }))
    .filter((f) => f.id);
}

function parseNoteCard(raw: unknown) {
  if (!raw || typeof raw !== "object") return undefined;
  const card = raw as Record<string, unknown>;
  const displayTitle =
    typeof card.displayTitle === "string" && card.displayTitle
      ? card.displayTitle
      : typeof card.title === "string" && card.title
        ? card.title
        : typeof card.note_title === "string"
          ? card.note_title
          : undefined;
  return {
    type: (card.type as "normal" | "video") ?? "normal",
    displayTitle,
    user: parseUser(card.user),
    interactInfo: parseInteractInfo(card.interactInfo ?? card.interact_info),
    cover: parseCover(card.cover),
  };
}

function parseUser(raw: unknown) {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  return {
    userId: String(u.userId ?? u.user_id ?? ""),
    nickname: String(u.nickname ?? ""),
    avatar:
      typeof u.images === "string" ? u.images : typeof u.avatar === "string" ? u.avatar : undefined,
    redId: typeof u.redId === "string" ? u.redId : undefined,
  };
}

function parseInteractInfo(raw: unknown) {
  if (!raw || typeof raw !== "object") return undefined;
  const i = raw as Record<string, unknown>;
  return {
    likedCount: typeof i.likedCount === "string" ? i.likedCount : String(i.liked_count ?? ""),
    collectedCount:
      typeof i.collectedCount === "string" ? i.collectedCount : String(i.collected_count ?? ""),
    commentCount:
      typeof i.commentCount === "string" ? i.commentCount : String(i.comment_count ?? ""),
    liked: typeof i.liked === "boolean" ? i.liked : undefined,
    collected: typeof i.collected === "boolean" ? i.collected : undefined,
  };
}

function parseCover(raw: unknown) {
  if (!raw || typeof raw !== "object") return undefined;
  const c = raw as Record<string, unknown>;
  return {
    url: typeof c.url === "string" ? c.url : undefined,
    urlDefault: typeof c.urlDefault === "string" ? c.urlDefault : undefined,
  };
}

// ============================================================================
// 搜索
// ============================================================================

export type SearchFilters = {
  sortBy?: "general" | "latest" | "most_liked" | "most_commented" | "most_collected";
  noteType?: "all" | "video" | "normal";
  timeRange?: "all" | "day" | "week" | "half_year";
  searchScope?: "all" | "viewed" | "not_viewed" | "following";
};

/**
 * 筛选面板 DOM 索引映射。
 * 小红书搜索页的筛选面板结构：
 *   div.filter-panel > div.filters:nth-child(N) > div.tags:nth-child(M)
 * 其中 N = filtersIndex（筛选组），M = tagsIndex（选项）
 */
const FILTER_MAP: Record<string, Record<string, { filtersIndex: number; tagsIndex: number }>> = {
  sortBy: {
    general:        { filtersIndex: 1, tagsIndex: 1 },
    latest:         { filtersIndex: 1, tagsIndex: 2 },
    most_liked:     { filtersIndex: 1, tagsIndex: 3 },
    most_commented: { filtersIndex: 1, tagsIndex: 4 },
    most_collected: { filtersIndex: 1, tagsIndex: 5 },
  },
  noteType: {
    all:    { filtersIndex: 2, tagsIndex: 1 },
    video:  { filtersIndex: 2, tagsIndex: 2 },
    normal: { filtersIndex: 2, tagsIndex: 3 },
  },
  timeRange: {
    all:       { filtersIndex: 3, tagsIndex: 1 },
    day:       { filtersIndex: 3, tagsIndex: 2 },
    week:      { filtersIndex: 3, tagsIndex: 3 },
    half_year: { filtersIndex: 3, tagsIndex: 4 },
  },
  searchScope: {
    all:         { filtersIndex: 4, tagsIndex: 1 },
    viewed:      { filtersIndex: 4, tagsIndex: 2 },
    not_viewed:  { filtersIndex: 4, tagsIndex: 3 },
    following:   { filtersIndex: 4, tagsIndex: 4 },
  },
};

function buildFilterClicks(filters: SearchFilters): Array<{ filtersIndex: number; tagsIndex: number }> {
  const clicks: Array<{ filtersIndex: number; tagsIndex: number }> = [];
  for (const [key, value] of Object.entries(filters)) {
    if (!value) continue;
    const group = FILTER_MAP[key];
    if (!group) continue;
    const mapping = group[value];
    if (!mapping) continue;
    // 跳过默认值（综合/不限），无需点击
    if (mapping.tagsIndex === 1) continue;
    clicks.push(mapping);
  }
  return clicks;
}

/**
 * 在搜索页应用筛选条件：hover 筛选按钮 → 等待面板 → 点击选项 → 等待结果刷新。
 * 参考 Go 版本 xiaohongshu-mcp 的 search.go 实现。
 */
async function applySearchFilters(
  targetId: string,
  clicks: Array<{ filtersIndex: number; tagsIndex: number }>,
  profile?: string,
): Promise<void> {
  // hover div.filter 触发筛选面板展开
  await evaluate(
    targetId,
    `() => {
      const btn = document.querySelector('div.filter');
      if (btn) {
        btn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      }
    }`,
    profile,
  );
  await sleep(800);

  // 等待筛选面板出现
  await evaluate(
    targetId,
    `() => new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (document.querySelector('div.filter-panel')) return resolve(true);
        if (Date.now() - start > 5000) return reject(new Error('filter-panel not found'));
        setTimeout(check, 200);
      };
      check();
    })`,
    profile,
  ).catch(() => null);

  // 依次点击各筛选选项
  for (const { filtersIndex, tagsIndex } of clicks) {
    const selector = `div.filter-panel div.filters:nth-child(${filtersIndex}) div.tags:nth-child(${tagsIndex})`;
    await evaluate(
      targetId,
      `() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (el) el.click();
      }`,
      profile,
    );
    await sleep(300);
  }

  // 点击完后移开鼠标，让面板收起
  await evaluate(
    targetId,
    `() => {
      const btn = document.querySelector('div.filter');
      if (btn) {
        btn.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
        btn.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      }
    }`,
    profile,
  );

  // 等待搜索结果刷新
  await sleep(2000);
}

export async function searchFeeds(
  keyword: string,
  filters?: SearchFilters,
  profile?: string,
): Promise<XhsFeed[]> {
  const targetId = await getOrCreateXhsTab(profile);
  const url = `${XHS_HOME}/search_result?keyword=${encodeURIComponent(keyword)}&source=web_explore_feed`;

  await navigate(targetId, url, profile).catch(() => null);
  await sleep(3000);

  // 应用筛选条件（如果有非默认值的筛选项）
  const filterClicks = filters ? buildFilterClicks(filters) : [];
  if (filterClicks.length > 0) {
    await applySearchFilters(targetId, filterClicks, profile);
  }

  // 策略 1：等待 __INITIAL_STATE__.search.feeds 有数据（最多 15 秒）
  for (let i = 0; i < 6; i++) {
    const data = await extractInitialState(targetId, "search.feeds", profile);
    if (Array.isArray(data) && data.length > 0) return parseFeedList(data);
    await sleep(2000);
  }

  // 策略 2：直接在页面上下文中读取 reactive proxy 的原始值
  const rawFeeds = await evaluate(
    targetId,
    `() => {
      try {
        const state = window.__INITIAL_STATE__;
        if (!state?.search?.feeds) return null;
        const feeds = state.search.feeds;
        const data = feeds._rawValue ?? feeds._value ?? feeds.value ?? feeds;
        if (!Array.isArray(data) || data.length === 0) return null;
        return JSON.stringify(data.map(f => ({
          id: f.id ?? f.noteId ?? '',
          xsecToken: f.xsecToken ?? f.xsec_token ?? '',
          modelType: f.modelType,
          noteCard: f.noteCard ?? f.note_card ?? null,
        })));
      } catch { return null; }
    }`,
    profile,
  );
  if (typeof rawFeeds === "string" && rawFeeds) {
    try {
      const parsed = JSON.parse(rawFeeds) as unknown[];
      if (parsed.length > 0) return parseFeedList(parsed);
    } catch {}
  }

  // 策略 3：API 拦截（注入 fetch hook 后触发搜索请求）
  await evaluate(
    targetId,
    `() => {
      if (window.__searchInterceptorInstalled) return;
      window.__searchInterceptorInstalled = true;
      window.__searchAPIResult = null;
      const origFetch = window.fetch;
      window.fetch = async function(...args) {
        const response = await origFetch.apply(this, args);
        const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url ?? '');
        if (url.includes('/api/sns/web/v1/search/notes')) {
          const clone = response.clone();
          clone.text().then(body => {
            try { window.__searchAPIResult = body; } catch {}
          }).catch(() => {});
        }
        return response;
      };
    }`,
    profile,
  );

  // 触发重新搜索（滚动或刷新搜索）
  await evaluate(targetId, `() => { window.scrollBy(0, 100); }`, profile);
  await sleep(3000);

  const apiResult = await evaluate(
    targetId,
    `() => window.__searchAPIResult`,
    profile,
  );
  if (typeof apiResult === "string" && apiResult) {
    try {
      const parsed = JSON.parse(apiResult) as Record<string, unknown>;
      const items = (parsed.data as Record<string, unknown>)?.items;
      if (Array.isArray(items) && items.length > 0) return parseFeedList(items);
    } catch {}
  }

  return [];
}

// ============================================================================
// 帖子详情（含评论）
// ============================================================================

export type GetFeedOptions = {
  loadAllComments?: boolean;
  expandSubComments?: boolean;
  maxCommentPages?: number;
};

export async function getFeed(
  feedId: string,
  xsecToken: string,
  opts?: GetFeedOptions,
  profile?: string,
): Promise<{ feed: XhsFeedDetail; comments: XhsCommentList } | null> {
  const url = `${XHS_HOME}/explore/${feedId}?xsec_token=${encodeURIComponent(xsecToken)}&xsec_source=pc_feed`;

  let targetId = await getOrCreateXhsTab(profile);
  let noteDetailMap: unknown = null;
  let commentApiPromise: Promise<{ url: string; status?: number; body: string } | null> | null = null;
  let freshTabOpened = false;

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt === 2) {
      // 最后一次：关闭旧标签页，开全新标签页
      await closeTab(targetId, profile).catch(() => null);
      const fresh = await openTab(url, profile);
      targetId = fresh.targetId;
      freshTabOpened = true;
      await sleep(3000);
    } else {
      // 第 0/1 次：复用现有标签页，发起/重发导航
      commentApiPromise = waitForResponseBody(
        targetId,
        "*/api/sns/web/v2/comment/page*",
        15000,
        profile,
      ).catch(() => null);
      await navigate(targetId, url, profile).catch(() => null);
      await sleep(attempt === 0 ? 2000 : 3000);
    }

    // 验证 URL 是否已导航到目标页面
    const currentUrl = (await evaluate(targetId, "() => window.location.href", profile).catch(() => "")) as string;
    if (!currentUrl?.includes(feedId)) continue;

    noteDetailMap = await waitForInitialState(targetId, "note.noteDetailMap", 10000, profile).catch(() => null);
    if (noteDetailMap && typeof noteDetailMap === "object") break;
  }

  if (!noteDetailMap || typeof noteDetailMap !== "object") {
    // 新 tab 加载失败，关闭防止泄漏
    if (freshTabOpened) {
      await closeTab(targetId, profile).catch(() => null);
    }
    return null;
  }

  const noteMap = noteDetailMap as Record<string, unknown>;
  const noteEntry = noteMap[feedId] ?? Object.values(noteMap)[0];
  if (!noteEntry || typeof noteEntry !== "object") return null;

  // Vue 响应式 Proxy 残留解包
  let entry = noteEntry as Record<string, unknown>;
  if (entry._value && typeof entry._value === "object") entry = entry._value as Record<string, unknown>;

  let noteData = (entry.note ?? entry) as Record<string, unknown>;
  if (noteData && typeof noteData === "object" && noteData._value && typeof noteData._value === "object") {
    noteData = noteData._value as Record<string, unknown>;
  }

  const feedDetail = parseFeedDetail(noteData);

  // 优先使用 API 拦截的评论数据（包含真实 ID）
  const commentApiResponse = commentApiPromise ? await commentApiPromise : null;
  let comments: XhsCommentList = { list: [] };

  if (commentApiResponse?.body) {
    comments = parseCommentApiResponse(commentApiResponse.body);
  }

  // 如果 API 拦截失败，降级到 DOM 提取
  if (comments.list.length === 0) {
    comments = await loadComments(
      targetId,
      opts?.loadAllComments ?? false,
      opts?.expandSubComments ?? false,
      opts?.maxCommentPages ?? 3,
      profile,
    );
  }

  return { feed: feedDetail, comments };
}

// 解析评论 API 响应（拦截 /api/sns/web/v2/comment/page）
function parseCommentApiResponse(body: string): XhsCommentList {
  try {
    const resp = JSON.parse(body) as {
      code: number;
      success: boolean;
      data?: {
        comments?: Array<{
          id: string;
          content: string;
          user_info?: { user_id?: string; nickname?: string };
          // sub_comment_count 是字符串格式
          sub_comment_count?: string;
          sub_comments?: Array<{
            id: string;
            content: string;
            user_info?: { user_id?: string; nickname?: string };
          }>;
        }>;
        has_more?: boolean;
        cursor?: string;
      };
    };
    if (!resp.success || !resp.data?.comments) return { list: [] };

    const list: XhsComment[] = resp.data.comments
      .filter((c) => c.content)
      .map((c) => {
        const subCommentCount = c.sub_comment_count ? parseInt(c.sub_comment_count, 10) : 0;
        const preloadedSubs = (c.sub_comments ?? []).filter((s) => s.content);
        // subCommentHasMore：API 预加载的子评论数量 < 总子评论数，说明还有更多未加载
        const subCommentHasMore = subCommentCount > preloadedSubs.length;

        return {
          id: c.id,
          content: c.content,
          userId: c.user_info?.user_id ?? "",
          userInfo: c.user_info?.nickname
            ? { userId: c.user_info.user_id ?? "", nickname: c.user_info.nickname }
            : undefined,
          subCommentCount: subCommentCount || undefined,
          subCommentHasMore: subCommentHasMore || undefined,
          subComments: preloadedSubs.map((s) => ({
            id: s.id,
            content: s.content,
            userId: s.user_info?.user_id ?? "",
            userInfo: s.user_info?.nickname
              ? { userId: s.user_info.user_id ?? "", nickname: s.user_info.nickname }
              : undefined,
          })),
        };
      });

    return {
      list,
      // hasMore=true 表示还有更多顶级评论未加载，不能用此列表判断评论是否存在
      hasMore: resp.data.has_more,
      cursor: resp.data.cursor,
    };
  } catch {
    return { list: [] };
  }
}

function parseFeedDetail(raw: unknown): XhsFeedDetail {
  if (!raw || typeof raw !== "object") return { noteId: "" };
  const n = raw as Record<string, unknown>;
  return {
    noteId: String(n.noteId ?? n.note_id ?? ""),
    xsecToken: typeof n.xsecToken === "string" ? n.xsecToken : undefined,
    title: typeof n.title === "string" ? n.title : undefined,
    desc: typeof n.desc === "string" ? n.desc : undefined,
    type: (n.type as "normal" | "video") ?? "normal",
    time: typeof n.time === "number" ? n.time : undefined,
    ipLocation: typeof n.ipLocation === "string" ? n.ipLocation : undefined,
    user: parseUser(n.user),
    interactInfo: parseInteractInfo(n.interactInfo ?? n.interact_info),
    imageList: Array.isArray(n.imageList)
      ? n.imageList.map((img: unknown) => {
          const i = img as Record<string, unknown>;
          return {
            url: typeof i.url === "string" ? i.url : undefined,
            urlDefault: typeof i.urlDefault === "string" ? i.urlDefault : undefined,
          };
        })
      : undefined,
  };
}

async function loadComments(
  targetId: string,
  loadAll: boolean,
  expandSub: boolean,
  maxPages: number,
  profile?: string,
): Promise<XhsCommentList> {
  // 滚动到评论区
  await evaluate(
    targetId,
    `() => {
      const el = document.querySelector('.comments-container, .interaction-container, #noteContainer');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }`,
    profile,
  );
  await sleep(800);

  // 检查是否有评论
  const noComments = await evaluate(
    targetId,
    `() => !!document.querySelector('[class*="no-comment"]')`,
    profile,
  );
  if (noComments === true) {
    return { list: [], hasMore: false };
  }

  if (!loadAll) {
    // 只获取当前可见评论
    return extractVisibleComments(targetId, expandSub, profile);
  }

  // 滚动加载所有评论
  let prevCount = 0;
  let stagnantRounds = 0;
  let page = 0;

  while (page < maxPages) {
    const count = await getCommentCount(targetId, profile);

    // 检测是否到达底部
    const isEnd = await evaluate(
      targetId,
      `() => !!document.querySelector('.end-container, [class*="the-end"]')`,
      profile,
    );
    if (isEnd === true) break;

    if (count === prevCount) {
      stagnantRounds++;
      if (stagnantRounds >= 3) break;
      await smartScroll(targetId, 1200, profile);
    } else {
      stagnantRounds = 0;
    }

    prevCount = count;
    await evaluate(
      targetId,
      `() => {
        const comments = document.querySelectorAll('.parent-comment');
        const last = comments[comments.length - 1];
        if (last) last.scrollIntoView({ behavior: 'smooth', block: 'end' });
      }`,
      profile,
    );
    await smartScroll(targetId, 600, profile);
    await sleep(600);
    page++;
  }

  return extractVisibleComments(targetId, expandSub, profile);
}

async function getCommentCount(targetId: string, profile?: string): Promise<number> {
  const count = await evaluate(
    targetId,
    `() => document.querySelectorAll('.parent-comment').length`,
    profile,
  );
  return typeof count === "number" ? count : 0;
}

async function extractVisibleComments(
  targetId: string,
  expandSub: boolean,
  profile?: string,
): Promise<XhsCommentList> {
  if (expandSub) {
    // 点击所有"展开更多回复"按钮
    await evaluate(
      targetId,
      `() => {
        document.querySelectorAll('.show-more').forEach(btn => {
          if (/展开/.test(btn.textContent)) btn.click();
        });
      }`,
      profile,
    );
    await sleep(1000);
  }

  const raw = await evaluate(
    targetId,
    `() => {
      const stripCommentPrefix = id => id.startsWith('comment-') ? id.slice(8) : id;
      const comments = [];
      document.querySelectorAll('.parent-comment').forEach(el => {
        const rawId = el.id || el.getAttribute('data-id') || '';
        const idEl = stripCommentPrefix(rawId);
        // 顶级评论内容：comment-item 下的 .note-text
        const commentItem = el.querySelector('[id^="comment-"]') || el;
        const contentEl = commentItem.querySelector('.note-text, .content, .comment-content');
        // 用户名：.name 在 .author-wrapper 或 .user-info 内
        const userEl = commentItem.querySelector('.author-wrapper .name, .user-info .name, .name');
        // 子评论：在 parent-comment 内所有 [id^="comment-"] 中排除自身
        const subComments = [];
        const selfId = commentItem.id || rawId;
        el.querySelectorAll('[id^="comment-"]').forEach(sub => {
          if (sub.id === selfId) return;
          const subContent = sub.querySelector('.note-text, .content');
          const subUser = sub.querySelector('.author-wrapper .name, .name');
          subComments.push({
            id: stripCommentPrefix(sub.id || ''),
            content: subContent ? subContent.textContent?.trim() : '',
            userId: sub.getAttribute('data-user-id') || '',
            nickname: subUser ? subUser.textContent?.trim() : '',
          });
        });
        comments.push({
          id: idEl,
          content: contentEl ? contentEl.textContent?.trim() : '',
          userId: el.getAttribute('data-user-id') || '',
          nickname: userEl ? userEl.textContent?.trim() : '',
          subComments,
        });
      });
      return JSON.stringify(comments);
    }`,
    profile,
  );

  if (typeof raw !== "string") return { list: [] };

  try {
    const parsed = JSON.parse(raw) as Array<{
      id: string;
      content: string;
      userId: string;
      nickname: string;
      subComments: Array<{ id: string; content: string; userId: string; nickname: string }>;
    }>;

    const list: XhsComment[] = parsed
      .filter((c) => c.content)
      .map((c) => ({
        id: c.id,
        content: c.content,
        userId: c.userId,
        userInfo: c.nickname ? { userId: c.userId, nickname: c.nickname } : undefined,
        subComments: c.subComments
          .filter((s) => s.content)
          .map((s) => ({
            id: s.id,
            content: s.content,
            userId: s.userId,
            userInfo: s.nickname ? { userId: s.userId, nickname: s.nickname } : undefined,
          })),
      }));

    return { list };
  } catch {
    return { list: [] };
  }
}

// ============================================================================
// 用户主页
// ============================================================================

export async function getUserProfile(
  userId: string,
  xsecToken: string,
  profile?: string,
): Promise<XhsUserProfile | null> {
  const url = `${XHS_HOME}/user/profile/${userId}?xsec_token=${encodeURIComponent(xsecToken)}&xsec_source=pc_note`;
  const { targetId } = await navigateWithWarmup(url, profile);

  // 等待用户数据
  const userPageData = await waitForInitialState(targetId, "user.userPageData", 10000, profile);
  const userNotes = await extractInitialState(targetId, "user.notes", profile);

  if (!userPageData || typeof userPageData !== "object") return null;

  const data = userPageData as Record<string, unknown>;
  const basicInfo = data.basicInfo as Record<string, unknown> | undefined;
  const interactions = data.interactions as Array<Record<string, unknown>> | undefined;

  return {
    basicInfo: {
      userId: String(basicInfo?.userId ?? basicInfo?.user_id ?? userId),
      nickname: String(basicInfo?.nickname ?? ""),
      avatar:
        typeof basicInfo?.imageb === "string"
          ? basicInfo.imageb
          : typeof basicInfo?.images === "string"
            ? basicInfo.images
            : undefined,
      redId: typeof basicInfo?.redId === "string" ? basicInfo.redId : undefined,
      desc: typeof basicInfo?.desc === "string" ? basicInfo.desc : undefined,
      gender: typeof basicInfo?.gender === "number" ? basicInfo.gender : undefined,
      ipLocation: typeof basicInfo?.ipLocation === "string" ? basicInfo.ipLocation : undefined,
    },
    interactions: Array.isArray(interactions)
      ? interactions.map((i) => ({
          type: String(i.type ?? ""),
          name: String(i.name ?? ""),
          count: String(i.count ?? ""),
        }))
      : undefined,
    feeds: Array.isArray(userNotes) ? parseFeedList(userNotes) : undefined,
  };
}

// ============================================================================
// 我的主页（对应 my_profile，从登录状态获取自己的 userId）
// ============================================================================

export async function getMyProfile(profile?: string): Promise<XhsUserProfile | null> {
  const { targetId } = await navigateWithWarmup(`${XHS_HOME}/explore`, profile);

  // 从首页 __INITIAL_STATE__ 提取当前登录用户的 userId
  const userId = await extractMyUserId(targetId, profile);
  if (!userId) return null;

  // 复用 getUserProfile 获取完整主页数据（无需 xsecToken）
  return getUserProfile(userId, "", profile);
}

async function extractMyUserId(targetId: string, profile?: string): Promise<string | null> {
  const raw = await evaluate(
    targetId,
    `() => {
      try {
        const state = window.__INITIAL_STATE__;
        if (!state) return null;
        const user = state.user?.userInfo || state.userInfo || {};
        const v = user._value || user.value || user;
        return v.userId || v.user_id || null;
      } catch { return null; }
    }`,
    profile,
  );
  return typeof raw === "string" && raw ? raw : null;
}

// ============================================================================
// 获取我的笔记列表
// ============================================================================

export async function getMyNotes(profile?: string): Promise<MyNote[]> {
  const myProfile = await getMyProfile(profile);
  if (!myProfile?.basicInfo?.userId) return [];

  // getMyProfile → getUserProfile 已导航到用户主页，复用已有 tab
  const targetId = await getOrCreateXhsTab(profile);
  const notesData = await extractInitialState(targetId, "user.notes", profile);

  if (!Array.isArray(notesData)) return [];

  // user.notes 是双重数组 [][]Feed，需要展平
  const flat = (notesData as unknown[]).flatMap((row) => (Array.isArray(row) ? row : [row]));

  return flat
    .filter((item): item is Record<string, unknown> => item != null && typeof item === "object")
    .map((item) => {
      const noteCard = (item.noteCard ?? item) as Record<string, unknown>;
      const interactInfo = noteCard.interactInfo as Record<string, unknown> | undefined;
      const cover = noteCard.cover as Record<string, unknown> | undefined;
      return {
        noteId: String(item.id ?? item.noteId ?? ""),
        xsecToken: typeof item.xsecToken === "string" ? item.xsecToken : undefined,
        title: typeof noteCard.displayTitle === "string" ? noteCard.displayTitle : undefined,
        type: noteCard.type === "video" ? "video" : "normal",
        time: typeof item.time === "number" ? item.time : undefined,
        interactInfo: interactInfo
          ? {
              likedCount: String(interactInfo.likedCount ?? ""),
              collectedCount: String(interactInfo.collectedCount ?? ""),
              commentCount: String(interactInfo.commentCount ?? ""),
              shareCount:
                typeof interactInfo.shareCount === "string" ? interactInfo.shareCount : undefined,
            }
          : undefined,
        cover: cover
          ? {
              url: typeof cover.url === "string" ? cover.url : undefined,
              urlDefault: typeof cover.urlDefault === "string" ? cover.urlDefault : undefined,
            }
          : undefined,
      } satisfies MyNote;
    })
    .filter((n) => n.noteId)
    .slice(0, 50); // 最多返回 50 篇
}

// ============================================================================
// 关注 / 取消关注用户
// ============================================================================

export async function followUser(
  userId: string,
  xsecToken: string,
  unfollow = false,
  profile?: string,
): Promise<{ success: boolean; followed: boolean; message: string }> {
  const url = `${XHS_HOME}/user/profile/${userId}?xsec_token=${encodeURIComponent(xsecToken)}&xsec_source=pc_note`;
  const targetId = await getOrCreateXhsTab(profile);

  // 用 JS 导航（不等待 load 事件，避免 20s 超时）
  await evaluate(
    targetId,
    `() => { window.location.href = ${JSON.stringify(url)}; }`,
    profile,
  ).catch(() => null);
  await sleep(3000);

  // 等待关注按钮出现（最多 8 秒）
  // 小红书用户主页关注按钮 class: "reds-button-new follow-button large primary follow-button"
  let btnFound = false;
  for (let i = 0; i < 8; i++) {
    const has = await evaluate(
      targetId,
      `() => {
        const btn = document.querySelector('.follow-button, .follow-btn, [class*="follow-button"]');
        return btn ? 1 : 0;
      }`,
      profile,
    ).catch(() => 0);
    if (has === 1) {
      btnFound = true;
      break;
    }
    await sleep(1000);
  }

  // 点击关注/取消关注按钮
  const clicked = await evaluate(
    targetId,
    `() => {
      // 小红书用户主页关注按钮：class 包含 follow-button
      const selectors = [
        '.follow-button',   // 主要选择器（已确认）
        '.follow-btn',
        '[class*="follow-button"]',
        'button[class*="follow"]',
      ];
      for (const sel of selectors) {
        const btn = document.querySelector(sel);
        if (btn) {
          btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
          if (typeof btn.click === 'function') btn.click();
          else btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          return btn.textContent?.trim() || 'clicked';
        }
      }
      return null;
    }`,
    profile,
  ).catch(() => null);

  if (!clicked) {
    // 降级：通过 ARIA 快照找关注按钮（name="关注"）
    const snap = await snapshot(targetId, { format: "aria", profile }).catch(() => ({ nodes: [] }));
    const followRef = snap.nodes?.find(
      (n) =>
        n.role === "button" && (n.name === "关注" || n.name === "已关注" || n.name === "互相关注"),
    )?.ref;
    if (!followRef) {
      return {
        success: false,
        followed: false,
        message: btnFound
          ? "找到关注按钮但点击失败"
          : "未找到关注按钮（.follow-button），请确认用户主页已加载",
      };
    }
    await act({ kind: "click", ref: followRef, targetId }, profile).catch(() => null);
  }

  await sleep(1500);

  // 验证：检查按钮文字是否变化（"关注" → "已关注" 或 "互相关注"）
  const btnText = await evaluate(
    targetId,
    `() => {
      const btn = document.querySelector('.follow-button, [class*="follow-button"], button[class*="follow"]');
      return btn ? btn.textContent?.trim() : null;
    }`,
    profile,
  ).catch(() => null);

  const isNowFollowed =
    typeof btnText === "string" && (btnText.includes("已关注") || btnText.includes("互相关注"));
  const expectedFollowed = !unfollow;
  const success = clicked !== null && (isNowFollowed === expectedFollowed || btnText !== "关注");
  return {
    success,
    followed: isNowFollowed,
    message: success
      ? unfollow
        ? "取消关注成功"
        : "关注成功"
      : `操作可能未生效（按钮文字: "${btnText}"）`,
  };
}

// ============================================================================
// 获取某条评论的所有子评论
// ============================================================================

export async function getSubComments(
  feedId: string,
  xsecToken: string,
  parentCommentId: string,
  profile?: string,
): Promise<{ subComments: XhsSubComment[]; parentFound: boolean; message: string }> {
  const url = `${XHS_HOME}/explore/${feedId}?xsec_token=${encodeURIComponent(xsecToken)}&xsec_source=pc_feed`;
  const targetId = await getOrCreateXhsTab(profile);

  await navigate(targetId, url, profile).catch(() => null);
  await sleep(2000);

  // 等待评论区加载
  let commentAreaReady = false;
  for (let i = 0; i < 15; i++) {
    const found = await evaluate(
      targetId,
      `() => document.querySelector('#noteContainer, .note-container, .note-scroller, .comments-container') ? 1 : 0`,
      profile,
    );
    if (found === 1) {
      commentAreaReady = true;
      break;
    }
    await sleep(1000);
  }
  if (!commentAreaReady) {
    return { subComments: [], parentFound: false, message: "评论区不可用" };
  }

  // 页面加载完成后注入 API 拦截器（必须在 navigate 之后，否则页面导航会重置 JS 上下文）
  await injectSubCommentAPIInterceptor(targetId, profile);

  // 滚动查找父评论
  const parentFound = await scrollToParentComment(targetId, parentCommentId, profile);
  if (!parentFound) {
    return { subComments: [], parentFound: false, message: `未找到父评论 ${parentCommentId}` };
  }

  // 点击"展开 N 条回复"
  const expandResult = await evaluate(
    targetId,
    `() => {
      const parentEl = document.getElementById('comment-${parentCommentId}');
      if (!parentEl) return 'parent-el-not-found';
      const parentComment = parentEl.closest('.parent-comment') || parentEl.parentElement;
      if (!parentComment) return 'parent-comment-not-found';
      const showMore = parentComment.querySelector('.show-more');
      if (!showMore) return 'no-show-more';
      showMore.scrollIntoView({ behavior: 'smooth', block: 'center' });
      showMore.click();
      return showMore.textContent?.trim() || 'clicked';
    }`,
    profile,
  );
  if (expandResult !== "parent-el-not-found" && expandResult !== "parent-comment-not-found" && expandResult !== "no-show-more") {
    await sleep(3000);
  }

  // 循环点击"展开更多回复"直到没有更多
  const maxExpandRounds = 30;
  for (let i = 0; i < maxExpandRounds; i++) {
    const moreText = await evaluate(
      targetId,
      `() => {
        const parentEl = document.getElementById('comment-${parentCommentId}');
        if (!parentEl) return 'parent-lost';
        const parentComment = parentEl.closest('.parent-comment') || parentEl.parentElement;
        if (!parentComment) return 'no-parent-comment';
        const showMore = parentComment.querySelector('.show-more');
        if (!showMore) return 'no-more';
        showMore.scrollIntoView({ block: 'center' });
        showMore.click();
        return showMore.textContent?.trim() || 'clicked';
      }`,
      profile,
    );
    if (moreText === "no-more" || moreText === "parent-lost" || moreText === "no-parent-comment") {
      break;
    }
    await sleep(2000);
  }

  // 优先从拦截的 API 响应中提取子评论（结构化数据，user_info 准确）
  const fromAPI = await readAllInterceptedComments(targetId, parentCommentId, profile);
  if (fromAPI.length > 0) {
    return {
      subComments: fromAPI,
      parentFound: true,
      message: `成功获取 ${fromAPI.length} 条子评论`,
    };
  }

  // API 拦截未捕获数据时，回退到 DOM 提取（解析文本以分离作者和内容）
  const fromDOM = await extractSubCommentsFromDOM(targetId, parentCommentId, profile);
  if (fromDOM.length > 0) {
    return {
      subComments: fromDOM,
      parentFound: true,
      message: `成功获取 ${fromDOM.length} 条子评论（DOM 提取，作者信息可能不完整）`,
    };
  }

  return { subComments: [], parentFound: true, message: "未能提取子评论（API 拦截和 DOM 提取均无结果）" };
}

// 注入宽泛的评论 API 拦截器，捕获所有包含 "comment" 的 API 响应
async function injectSubCommentAPIInterceptor(targetId: string, profile?: string): Promise<void> {
  await evaluate(
    targetId,
    `() => {
      if (window.__subCommentInterceptorInstalled) return;
      window.__subCommentInterceptorInstalled = true;
      window.__interceptedCommentResponses = [];

      const origFetch = window.fetch;
      window.fetch = async function(...args) {
        const response = await origFetch.apply(this, args);
        const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url ?? '');
        if (url.includes('/comment/')) {
          const clone = response.clone();
          clone.text().then(body => {
            try {
              const parsed = JSON.parse(body);
              if (parsed.success && parsed.data && Array.isArray(parsed.data.comments)) {
                window.__interceptedCommentResponses.push({ url, body });
              }
            } catch {}
          }).catch(() => {});
        }
        return response;
      };

      const origXHROpen = XMLHttpRequest.prototype.open;
      const origXHRSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this.__xhrUrl = url;
        return origXHROpen.call(this, method, url, ...rest);
      };
      XMLHttpRequest.prototype.send = function(...args) {
        const url = this.__xhrUrl || '';
        if (url.includes('/comment/')) {
          this.addEventListener('load', () => {
            try {
              const parsed = JSON.parse(this.responseText);
              if (parsed.success && parsed.data && Array.isArray(parsed.data.comments)) {
                window.__interceptedCommentResponses.push({ url, body: this.responseText });
              }
            } catch {}
          });
        }
        return origXHRSend.apply(this, args);
      };
    }`,
    profile,
  );
}

// 从所有拦截的评论 API 中提取子评论（sub/page 的直接结果 + 主评论 API 中嵌套的 sub_comments）
async function readAllInterceptedComments(
  targetId: string,
  parentCommentId: string,
  profile?: string,
): Promise<XhsSubComment[]> {
  const raw = await evaluate(
    targetId,
    `() => JSON.stringify(window.__interceptedCommentResponses ?? [])`,
    profile,
  );
  if (typeof raw !== "string") return [];

  try {
    const entries = JSON.parse(raw) as Array<{ url: string; body: string }>;
    const seen = new Set<string>();
    const result: XhsSubComment[] = [];

    const pushComment = (c: { id: string; content: string; user_info?: { user_id?: string; nickname?: string } }) => {
      if (!c.id || seen.has(c.id) || c.id === parentCommentId) return;
      seen.add(c.id);
      result.push({
        id: c.id,
        content: c.content,
        userId: c.user_info?.user_id ?? "",
        userInfo: c.user_info?.nickname
          ? { userId: c.user_info.user_id ?? "", nickname: c.user_info.nickname }
          : undefined,
      });
    };

    for (const entry of entries) {
      const resp = JSON.parse(entry.body) as {
        data?: {
          comments?: Array<{
            id: string;
            content: string;
            user_info?: { user_id?: string; nickname?: string };
            sub_comments?: Array<{
              id: string;
              content: string;
              user_info?: { user_id?: string; nickname?: string };
            }>;
          }>;
        };
      };

      const isSubPage = entry.url.includes("/comment/sub/");
      for (const c of resp.data?.comments ?? []) {
        if (isSubPage) {
          // sub/page 接口：comments 数组直接就是子评论
          pushComment(c);
        } else {
          // 主评论 page 接口：只取匹配父评论的 sub_comments
          if (c.id === parentCommentId) {
            for (const s of c.sub_comments ?? []) {
              pushComment(s);
            }
          }
        }
      }
    }
    return result;
  } catch {
    return [];
  }
}

// DOM 兜底：从页面 DOM 提取子评论，解析 "回复 XXX : " 前缀
async function extractSubCommentsFromDOM(
  targetId: string,
  parentCommentId: string,
  profile?: string,
): Promise<XhsSubComment[]> {
  const raw = await evaluate(
    targetId,
    `() => {
      const stripPrefix = id => id.startsWith('comment-') ? id.slice(8) : id;
      const parentEl = document.getElementById('comment-${parentCommentId}');
      if (!parentEl) return JSON.stringify([]);
      const parentComment = parentEl.closest('.parent-comment') || parentEl.parentElement;
      if (!parentComment) return JSON.stringify([]);

      const subs = [];
      const parentId = 'comment-${parentCommentId}';

      parentComment.querySelectorAll('[id^="comment-"]').forEach(el => {
        if (el.id === parentId) return;

        // 取作者名：优先 .author-wrapper .name，降级到 .name
        const allNameEls = el.querySelectorAll('.author-wrapper .name, .name');
        let authorName = '';
        for (const n of allNameEls) {
          if (!n.closest('.note-text, .reply-content, .reply-to-container')) {
            authorName = n.textContent?.trim() || '';
            if (authorName) break;
          }
        }

        // 提取完整文本内容
        const contentEl = el.querySelector('.note-text, .content, .comment-content');
        let fullText = contentEl ? contentEl.textContent?.trim() : el.textContent?.trim()?.slice(0, 300) || '';

        // 解析 "回复 XXX : " 前缀，提取干净内容
        let replyTarget = '';
        let cleanContent = fullText;
        const m = fullText.match(/^回复\\s+(.+?)\\s*[：:]\\s*/);
        if (m) {
          replyTarget = m[1];
          cleanContent = fullText.slice(m[0].length);
        }

        // 如果 authorName 为空但等于 replyTarget，说明选择器拿到的是被回复人
        if (authorName && authorName === replyTarget) authorName = '';
        // 如果仍为空，取第一个 .name 作为最后尝试（可能是作者也可能是被回复人）
        if (!authorName && allNameEls.length > 0) {
          const firstNameText = allNameEls[0].textContent?.trim() || '';
          if (firstNameText !== replyTarget) authorName = firstNameText;
        }

        subs.push({
          id: stripPrefix(el.id || ''),
          content: cleanContent,
          userId: el.getAttribute('data-user-id') || '',
          nickname: authorName,
          replyTarget,
        });
      });
      return JSON.stringify(subs);
    }`,
    profile,
  );

  if (typeof raw !== "string") return [];
  try {
    const items = JSON.parse(raw) as Array<{
      id: string;
      content: string;
      userId: string;
      nickname: string;
      replyTarget: string;
    }>;
    return items
      .filter((s) => s.content)
      .map((s) => ({
        id: s.id,
        content: s.content,
        userId: s.userId,
        userInfo: s.nickname ? { userId: s.userId, nickname: s.nickname } : undefined,
      }));
  } catch {
    return [];
  }
}

// 滚动查找顶级评论（复用 loadComments 的滚动逻辑）
async function scrollToParentComment(
  targetId: string,
  commentId: string,
  profile?: string,
): Promise<boolean> {
  // 先检查是否已在 DOM 中
  const alreadyVisible = await evaluate(
    targetId,
    `() => {
      const el = document.getElementById('comment-${commentId}');
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); return true; }
      return false;
    }`,
    profile,
  );
  if (alreadyVisible === true) return true;

  // 滚动到评论区
  await evaluate(
    targetId,
    `() => {
      const el = document.querySelector('.comments-container, .interaction-container, #noteContainer');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }`,
    profile,
  );
  await sleep(800);

  // 滚动加载更多评论，最多 20 轮
  let prevCount = 0;
  let stagnant = 0;
  for (let page = 0; page < 20; page++) {
    const found = await evaluate(
      targetId,
      `() => {
        const el = document.getElementById('comment-${commentId}');
        if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); return true; }
        return false;
      }`,
      profile,
    );
    if (found === true) return true;

    const count = await getCommentCount(targetId, profile);
    const isEnd = await evaluate(
      targetId,
      `() => !!document.querySelector('.end-container, [class*="the-end"]')`,
      profile,
    );
    if (isEnd === true) break;

    if (count === prevCount) {
      stagnant++;
      if (stagnant >= 3) break;
      await smartScroll(targetId, 1200, profile);
    } else {
      stagnant = 0;
    }
    prevCount = count;

    await evaluate(
      targetId,
      `() => {
        const comments = document.querySelectorAll('.parent-comment');
        const last = comments[comments.length - 1];
        if (last) last.scrollIntoView({ behavior: 'smooth', block: 'end' });
      }`,
      profile,
    );
    await smartScroll(targetId, 600, profile);
    await sleep(600);
  }

  // 最后再检查一次
  const finalCheck = await evaluate(
    targetId,
    `() => {
      const el = document.getElementById('comment-${commentId}');
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); return true; }
      return false;
    }`,
    profile,
  );
  return finalCheck === true;
}

