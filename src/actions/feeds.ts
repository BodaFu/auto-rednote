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
  waitForSelector,
  waitForResponseBody,
  act,
  sleep,
  snapshot,
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
};

const SORT_INDEX_MAP: Record<string, number> = {
  general: 1,
  latest: 2,
  most_liked: 3,
  most_commented: 4,
  most_collected: 5,
};

const NOTE_TYPE_INDEX_MAP: Record<string, number> = {
  all: 1,
  video: 2,
  normal: 3,
};

const TIME_RANGE_INDEX_MAP: Record<string, number> = {
  all: 1,
  day: 2,
  week: 3,
  half_year: 4,
};

export async function searchFeeds(
  keyword: string,
  filters?: SearchFilters,
  profile?: string,
): Promise<XhsFeed[]> {
  // 复用已有 tab，用 JS 导航并拦截搜索 API 响应（避免等待 load 事件超时）
  const targetId = await getOrCreateXhsTab(profile);
  const url = `${XHS_HOME}/search_result?keyword=${encodeURIComponent(keyword)}&source=web_explore_feed`;

  // 先启动响应拦截，再触发导航
  const responsePromise = waitForResponseBody(
    targetId,
    "*/api/sns/web/v1/search/notes*",
    15000,
    profile,
  ).catch(() => null);

  await evaluate(targetId, `() => { window.location.href = ${JSON.stringify(url)}; }`, profile);

  const apiResponse = await responsePromise;
  if (apiResponse?.body) {
    try {
      const parsed = JSON.parse(apiResponse.body) as Record<string, unknown>;
      const items = (parsed.data as Record<string, unknown>)?.items;
      if (Array.isArray(items)) {
        return parseFeedList(items);
      }
    } catch {
      // 降级到 state 提取
    }
  }

  // 降级：从 __INITIAL_STATE__ 提取
  await sleep(3000);
  let data = await extractInitialState(targetId, "search.feeds", profile);
  if (!data) {
    data = await extractInitialState(targetId, "search.noteList", profile);
  }
  if (!data) return [];
  return parseFeedList(data);
}

async function applySearchFilters(
  targetId: string,
  filters: SearchFilters,
  profile?: string,
): Promise<void> {
  // 悬停筛选按钮展开面板
  const filterRef = await findRefBySelector(targetId, "div.filter, [class*='filter-btn']", profile);
  if (!filterRef) return;

  await act({ kind: "hover", ref: filterRef, targetId }, profile);
  await sleep(500);

  try {
    await waitForSelector(targetId, "div.filter-panel, [class*='filter-panel']", 3000, profile);
  } catch {
    return;
  }

  // 排序
  if (filters.sortBy && filters.sortBy !== "general") {
    const idx = SORT_INDEX_MAP[filters.sortBy] ?? 1;
    await clickFilterOption(targetId, 1, idx, profile);
    await sleep(500);
  }

  // 笔记类型
  if (filters.noteType && filters.noteType !== "all") {
    const idx = NOTE_TYPE_INDEX_MAP[filters.noteType] ?? 1;
    await clickFilterOption(targetId, 2, idx, profile);
    await sleep(500);
  }

  // 时间范围
  if (filters.timeRange && filters.timeRange !== "all") {
    const idx = TIME_RANGE_INDEX_MAP[filters.timeRange] ?? 1;
    await clickFilterOption(targetId, 3, idx, profile);
    await sleep(500);
  }

  // 等待结果更新
  await sleep(1500);
}

async function clickFilterOption(
  targetId: string,
  filtersIndex: number,
  tagsIndex: number,
  profile?: string,
): Promise<void> {
  const fn = `() => {
    const panels = document.querySelectorAll('div.filter-panel div.filters');
    const panel = panels[${filtersIndex - 1}];
    if (!panel) return false;
    const tags = panel.querySelectorAll('div.tags');
    const tag = tags[${tagsIndex - 1}];
    if (!tag) return false;
    tag.click();
    return true;
  }`;
  await evaluate(targetId, fn, profile);
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

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt === 2) {
      // 最后一次：关闭旧标签页，开全新标签页
      await closeTab(targetId, profile).catch(() => null);
      const fresh = await openTab(url, profile);
      targetId = fresh.targetId;
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
    return null;
  }

  const noteMap = noteDetailMap as Record<string, unknown>;
  const noteEntry = noteMap[feedId] ?? Object.values(noteMap)[0];
  if (!noteEntry || typeof noteEntry !== "object") return null;

  const entry = noteEntry as Record<string, unknown>;
  const feedDetail = parseFeedDetail(entry.note ?? entry);

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
      const el = document.querySelector('.comments-container, #comments');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }`,
    profile,
  );
  await sleep(800);

  // 检查是否有评论
  const noComments = await evaluate(
    targetId,
    `() => !!document.querySelector('.no-comments-text, [class*="no-comment"]')`,
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
      // 大幅滚动尝试触发懒加载
      await evaluate(targetId, `() => window.scrollBy(0, window.innerHeight * 2)`, profile);
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
        else window.scrollBy(0, window.innerHeight);
      }`,
      profile,
    );
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
      // el.id 格式为 "comment-{realId}"，需去掉前缀
      const stripCommentPrefix = id => id.startsWith('comment-') ? id.slice(8) : id;
      const comments = [];
      document.querySelectorAll('.parent-comment').forEach(el => {
        const rawId = el.id || el.getAttribute('data-id') || '';
        const idEl = stripCommentPrefix(rawId);
        const contentEl = el.querySelector('.content, .comment-content, p.note-text');
        const userEl = el.querySelector('.user-info .name, .author-name, .nickname');
        const subComments = [];
        el.querySelectorAll('.child-comment, .sub-comment').forEach(sub => {
          const subContent = sub.querySelector('.content, p.note-text');
          const subUser = sub.querySelector('.user-info .name, .nickname');
          const subRawId = sub.id || sub.getAttribute('data-id') || '';
          subComments.push({
            id: stripCommentPrefix(subRawId),
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
  // 导航到首页，从 __INITIAL_STATE__ 中提取当前登录用户信息
  const { targetId } = await navigateWithWarmup(`${XHS_HOME}/explore`, profile);

  const userInfo = await extractInitialState(targetId, "user.userInfo", profile);

  if (userInfo && typeof userInfo === "object") {
    const info = userInfo as Record<string, unknown>;
    const userId = String(info.userId ?? info.user_id ?? "");
    if (userId) {
      // 尝试直接从 __INITIAL_STATE__ 构建 profile
      const basicInfo = info.basicInfo as Record<string, unknown> | undefined;
      if (basicInfo) {
        return {
          basicInfo: {
            userId,
            nickname: String(basicInfo.nickname ?? ""),
            avatar:
              typeof basicInfo.imageb === "string"
                ? basicInfo.imageb
                : typeof basicInfo.images === "string"
                  ? basicInfo.images
                  : undefined,
            redId: typeof basicInfo.redId === "string" ? basicInfo.redId : undefined,
            desc: typeof basicInfo.desc === "string" ? basicInfo.desc : undefined,
            gender: typeof basicInfo.gender === "number" ? basicInfo.gender : undefined,
            ipLocation: typeof basicInfo.ipLocation === "string" ? basicInfo.ipLocation : undefined,
          },
        };
      }

      // 否则通过 userId 获取完整 profile（无需 xsecToken）
      const profileUrl = `${XHS_HOME}/user/profile/${userId}`;
      const { targetId: profileTabId } = await navigateWithWarmup(profileUrl, profile);
      const userPageData = await waitForInitialState(
        profileTabId,
        "user.userPageData",
        10000,
        profile,
      );
      if (userPageData && typeof userPageData === "object") {
        const data = userPageData as Record<string, unknown>;
        const bi = data.basicInfo as Record<string, unknown> | undefined;
        const interactions = data.interactions as Array<Record<string, unknown>> | undefined;
        return {
          basicInfo: {
            userId: String(bi?.userId ?? bi?.user_id ?? userId),
            nickname: String(bi?.nickname ?? ""),
            avatar:
              typeof bi?.imageb === "string"
                ? bi.imageb
                : typeof bi?.images === "string"
                  ? bi.images
                  : undefined,
            redId: typeof bi?.redId === "string" ? bi.redId : undefined,
            desc: typeof bi?.desc === "string" ? bi.desc : undefined,
            gender: typeof bi?.gender === "number" ? bi.gender : undefined,
            ipLocation: typeof bi?.ipLocation === "string" ? bi.ipLocation : undefined,
          },
          interactions: Array.isArray(interactions)
            ? interactions.map((i) => ({
                type: String(i.type ?? ""),
                name: String(i.name ?? ""),
                count: String(i.count ?? ""),
              }))
            : undefined,
        };
      }
    }
  }

  // 最后回退：从页面 DOM 提取登录用户信息
  const raw = await evaluate(
    targetId,
    `() => {
      const state = window.__INITIAL_STATE__
      if (!state) return null
      const user = state.user?.userInfo || state.userInfo || {}
      return JSON.stringify({
        userId: user.userId || user.user_id || '',
        nickname: user.nickname || '',
        avatar: user.imageb || user.images || '',
        redId: user.redId || '',
        desc: user.desc || '',
      })
    }`,
    profile,
  );

  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as Record<string, string>;
      if (parsed.userId) {
        return {
          basicInfo: {
            userId: parsed.userId,
            nickname: parsed.nickname,
            avatar: parsed.avatar || undefined,
            redId: parsed.redId || undefined,
            desc: parsed.desc || undefined,
          },
        };
      }
    } catch {
      // ignore
    }
  }

  return null;
}

// ============================================================================
// 获取我的笔记列表
// ============================================================================

export async function getMyNotes(profile?: string): Promise<MyNote[]> {
  // 先获取自己的 userId
  const myProfile = await getMyProfile(profile);
  if (!myProfile?.basicInfo?.userId) return [];

  const userId = myProfile.basicInfo.userId;
  const { targetId } = await navigateWithWarmup(`${XHS_HOME}/user/profile/${userId}`, profile);

  // 等待用户主页数据加载（与 getUserProfile 保持一致）
  await waitForInitialState(targetId, "user.userPageData", 10000, profile).catch(() => null);
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

        // 取所有 .name 元素，区分作者和被回复人
        const allNameEls = el.querySelectorAll('.name, .author-name, .nickname');
        let authorName = '';
        for (const n of allNameEls) {
          // 不在 .note-text / .reply-content 内的是作者
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
      const el = document.querySelector('.comments-container, #comments');
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
      await evaluate(targetId, `() => window.scrollBy(0, window.innerHeight * 2)`, profile);
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
        else window.scrollBy(0, window.innerHeight);
      }`,
      profile,
    );
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

// ============================================================================
// 内部辅助
// ============================================================================

async function findRefBySelector(
  targetId: string,
  selector: string,
  profile?: string,
): Promise<string | null> {
  const snap = await snapshot(targetId, { format: "aria", selector, profile });
  if (!snap.nodes?.length) return null;
  return snap.nodes[0]?.ref ?? null;
}
