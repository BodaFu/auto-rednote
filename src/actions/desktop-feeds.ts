/**
 * desktop-feeds.ts - 桌面端小红书 Feed / 搜索 / 详情操作
 *
 * 通过 Ghost OS 操作小红书 macOS App（iOS on Mac），
 * 替代网页端 CDP 操作，降低风控风险。
 *
 * 数据提取策略：
 * - 主要依赖 ghost_read 的 AX 树深度遍历，提取文本内容
 * - AX 树信息不足时，返回截图让 Agent 做视觉分析
 * - 不依赖 window.__INITIAL_STATE__，桌面端工具自成体系
 *
 * 与网页端工具的区别：
 * - 无 feedId/xsecToken（桌面端无法获取这些内部 ID）
 * - 返回的是 AX 树提取的文本数据 + 位置索引
 * - 操作通过 GUI 点击/输入完成，速度较慢但更像真人
 */

import type { GhostConfig } from "../desktop/ghost.js";
import {
  DEFAULT_GHOST_CONFIG,
  ghostRead,
  ghostClickCoords,
  ghostClickQuery,
  ghostType,
  ghostPress,
  ghostHotkey,
  ghostScroll,
  ghostScreenshot,
  ghostFind,
  sleep,
  type GhostScreenshot,
} from "../desktop/ghost.js";

const TAG = "[desktop-feeds]";
function log(...args: unknown[]): void {
  console.error(TAG, ...args);
}

// ============================================================================
// 布局常量（1512×949 全屏窗口，窗口相对坐标）
// ============================================================================

const BOTTOM_NAV = {
  home: { x: 151, y: 930 },
  market: { x: 453, y: 930 },
  post: { x: 756, y: 930 },
  messages: { x: 1058, y: 930 },
  profile: { x: 1360, y: 930 },
} as const;

const BACK_BUTTON = { x: 25, y: 27 } as const;

// ============================================================================
// 返回类型
// ============================================================================

/** 桌面端 Feed 条目（从 AX 树解析） */
export interface DesktopFeedItem {
  /** 在列表中的位置索引（从 0 开始） */
  index: number;
  /** 笔记标题 */
  title: string;
  /** 作者昵称 */
  author: string;
  /** 点赞数（文本，如 "1917"、"赞"） */
  likeCount: string;
  /** 是否为广告 */
  isAd: boolean;
}

/** 桌面端搜索结果条目 */
export interface DesktopSearchItem {
  index: number;
  /** 内容摘要（标题 + 部分正文） */
  content: string;
  author: string;
  /** 发布时间（文本，如 "4小时前"、"2025-06-18"） */
  time: string;
  likeCount: string;
}

/** 桌面端帖子详情 */
export interface DesktopFeedDetail {
  /** 原始 AX 树文本（完整内容） */
  rawText: string;
  /** 截图（用于 Agent 视觉分析，截图权限不足时为 null） */
  screenshot: GhostScreenshot | null;
}

// ============================================================================
// AX 树文本解析
// ============================================================================

/**
 * 从首页 AX 树文本中解析 Feed 列表。
 *
 * 首页 AX 树的典型模式：
 * ```
 * [button] Button          ← 分隔符
 * 大佬们的35岁             ← 标题
 * [button] Button          ← 分隔符
 * 何加盐                   ← 作者
 * [button] 1917            ← 点赞数
 * ```
 *
 * 广告条目在标题前有 "广告" 行。
 */
function parseHomeFeedItems(content: string): DesktopFeedItem[] {
  const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
  const items: DesktopFeedItem[] = [];

  // 跳过头部导航区域（标签页栏、分类 Tab 等）
  // 找到第一个 Feed 条目的起始位置：在分类标签之后
  const categoryKeywords = [
    "关注", "发现", "推荐", "视频", "直播", "短剧", "穿搭", "美食",
    "学习", "读书", "体育", "旅行", "音乐", "职场", "影视", "摄影",
  ];

  let feedStartIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    if (categoryKeywords.includes(lines[i]!)) {
      feedStartIdx = i;
    }
  }
  feedStartIdx += 1;

  let isAd = false;
  let i = feedStartIdx;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line === "小红书") break;

    if (line === "广告") {
      isAd = true;
      i++;
      continue;
    }

    if (line.startsWith("[button]")) {
      i++;
      continue;
    }

    // 可能是标题行 - 检查后续是否有作者和点赞数的模式
    const title = line;
    let author = "";
    let likeCount = "";

    // 向后扫描找作者和点赞数
    let j = i + 1;
    while (j < lines.length && lines[j]!.startsWith("[button]")) j++;

    if (j < lines.length && !lines[j]!.startsWith("[button]") && lines[j] !== "小红书" && lines[j] !== "广告") {
      author = lines[j]!;
      j++;
      // 找点赞数
      while (j < lines.length) {
        const nextLine = lines[j]!;
        if (nextLine.startsWith("[button] ")) {
          const btnText = nextLine.replace("[button] ", "").trim();
          if (btnText !== "Button" && btnText !== "") {
            likeCount = btnText;
            j++;
            break;
          }
        }
        j++;
        if (!lines[j]?.startsWith("[button]")) break;
      }
    }

    if (author) {
      items.push({
        index: items.length,
        title,
        author,
        likeCount: likeCount || "0",
        isAd,
      });
      isAd = false;
      i = j;
    } else {
      i++;
    }
  }

  return items;
}

/**
 * 从搜索结果 AX 树文本中解析搜索条目。
 *
 * 搜索结果 AX 树的典型模式（每条结果占 4-5 行）：
 * ```
 * 比利时电信巨头...        ← 内容摘要（长文本，非 [button] 开头）
 * [button] Button          ← 分隔符（忽略）
 * 洋的笔记                 ← 作者名（短文本）
 * 4小时前                  ← 时间
 * [button] 3               ← 点赞数
 * ```
 *
 * 识别策略：以点赞数行 `[button] 数字` 为锚点，向上回溯提取时间、作者、内容。
 */
function parseSearchItems(content: string): DesktopSearchItem[] {
  const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
  const items: DesktopSearchItem[] = [];

  // 跳过搜索框和筛选 Tab
  const filterTabs = ["全部", "用户", "商品", "地点", "群聊"];
  let startIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    if (filterTabs.includes(lines[i]!)) {
      startIdx = i;
    }
  }
  startIdx += 1;

  // 收集所有有意义的行（去掉 [button] Button 和 StaticText 分隔符）
  const meaningful: Array<{ text: string; originalIdx: number; isLikeButton: boolean }> = [];
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === "小红书") break;
    if (line === "StaticText") continue;
    if (line === "[button] Button") continue;

    // 点赞数按钮：[button] 数字
    const likeMatch = line.match(/^\[button\]\s+(\d+)$/);
    if (likeMatch) {
      meaningful.push({ text: likeMatch[1]!, originalIdx: i, isLikeButton: true });
      continue;
    }

    // 跳过其他 [button] 行（如 [button] recommend_search_button）
    if (line.startsWith("[button]")) continue;

    meaningful.push({ text: line, originalIdx: i, isLikeButton: false });
  }

  // 以点赞数按钮为锚点，向上回溯
  for (let m = 0; m < meaningful.length; m++) {
    if (!meaningful[m]!.isLikeButton) continue;

    const likeCount = meaningful[m]!.text;

    // 向上找时间、作者、内容
    let time = "";
    let author = "";
    let contentText = "";

    let cursor = m - 1;

    // 时间行（可选）
    if (cursor >= 0 && !meaningful[cursor]!.isLikeButton && isTimeString(meaningful[cursor]!.text)) {
      time = meaningful[cursor]!.text;
      cursor--;
    }

    // 作者行
    if (cursor >= 0 && !meaningful[cursor]!.isLikeButton) {
      author = meaningful[cursor]!.text;
      cursor--;
    }

    // 内容行（可能有多行，取最近的非时间、非作者行）
    if (cursor >= 0 && !meaningful[cursor]!.isLikeButton) {
      contentText = meaningful[cursor]!.text;
    }

    if (contentText && author) {
      items.push({
        index: items.length,
        content: contentText,
        author,
        time,
        likeCount,
      });
    }
  }

  return items;
}

function isTimeString(s: string): boolean {
  return /\d+[小时分钟秒天周月年]前/.test(s) ||
    /^\d{4}-\d{2}-\d{2}/.test(s) ||
    /^(昨天|前天|星期[一二三四五六日天])/.test(s) ||
    /^\d{2}-\d{2}$/.test(s);
}

// ============================================================================
// 导航辅助
// ============================================================================

async function ensureHomePage(cfg: GhostConfig): Promise<void> {
  log("ensureHomePage: 点击首页 Tab");
  await ghostClickCoords(BOTTOM_NAV.home.x, BOTTOM_NAV.home.y, cfg);
  await sleep(800);
}

async function navigateBack(cfg: GhostConfig): Promise<void> {
  log("navigateBack: 点击返回按钮");
  await ghostClickCoords(BACK_BUTTON.x, BACK_BUTTON.y, cfg);
  await sleep(500);
}

// ============================================================================
// 公开 API
// ============================================================================

/**
 * 获取小红书首页推荐 Feed 列表。
 *
 * 操作流程：
 * 1. 确保在首页
 * 2. 读取 AX 树提取 Feed 卡片信息
 * 3. 解析标题、作者、点赞数
 */
export async function desktopListFeeds(
  cfg: GhostConfig = DEFAULT_GHOST_CONFIG,
): Promise<{ items: DesktopFeedItem[]; screenshot: GhostScreenshot | null; rawText: string }> {
  const t0 = Date.now();
  log("desktopListFeeds: START");

  await ensureHomePage(cfg);

  const { content } = await ghostRead(cfg, 80);
  const items = parseHomeFeedItems(content);
  const screenshot = await ghostScreenshot(cfg).catch((err) => {
    log(`desktopListFeeds: 截图失败（${err}），继续返回文本数据`);
    return null;
  });

  log(`desktopListFeeds: DONE (${Date.now() - t0}ms) items=${items.length}`);
  return { items, screenshot, rawText: content };
}

/**
 * 在小红书桌面 App 中搜索内容。
 *
 * 操作流程：
 * 1. 确保在首页
 * 2. 点击搜索入口（热搜词区域）
 * 3. 清空并输入关键词
 * 4. 按 Return 搜索
 * 5. 等待结果加载
 * 6. 读取 AX 树提取搜索结果
 */
export async function desktopSearch(
  keyword: string,
  cfg: GhostConfig = DEFAULT_GHOST_CONFIG,
): Promise<{ items: DesktopSearchItem[]; screenshot: GhostScreenshot | null; rawText: string }> {
  const t0 = Date.now();
  log(`desktopSearch: START keyword="${keyword}"`);

  await ensureHomePage(cfg);

  // 小红书 iOS App 没有直接的搜索框 AX 元素，
  // 需要先点击顶部热搜词进入搜索编辑状态，再清空输入自定义关键词。
  // 热搜词在顶部导航栏右侧，通过 ghost_read 提取后用 ghost_find 定位。
  const { content: homeContent } = await ghostRead(cfg, 30);
  let enteredSearch = false;

  // 从 AX 树中提取热搜词：位于顶部导航栏区域（y < 80 屏幕绝对坐标）的短文本
  // 热搜词在 "关注"/"发现" Tab 和分类标签之间
  const homeLines = homeContent.split("\n").map((l) => l.trim()).filter(Boolean);
  const skipKeywords = new Set([
    "关注", "发现", "推荐", "小红书", "标签页栏", "广告",
    "视频", "直播", "短剧", "穿搭", "美食", "学习", "读书",
    "体育", "旅行", "音乐", "职场", "影视", "摄影", "健身塑型",
    "科学科普", "动漫", "减脂", "汽车", "搞笑", "情感", "美甲",
    "明星", "手工", "StaticText",
  ]);

  for (const line of homeLines) {
    if (skipKeywords.has(line)) continue;
    if (line.startsWith("[button]")) continue;
    // 热搜词通常是 4-15 个中文字的短语
    if (line.length >= 4 && line.length <= 20) {
      const elements = await ghostFind(line, cfg, { depth: 30 }).catch(() => []);
      // 热搜词在屏幕顶部（y < 80），排除 Feed 区域的内容
      const topElement = elements.find((e) => e.position.y < 80);
      if (topElement) {
        log(`desktopSearch: 点击热搜词 "${line}" 进入搜索`);
        await ghostClickQuery(line, cfg);
        enteredSearch = true;
        break;
      }
    }
  }

  if (!enteredSearch) {
    // 备用方案：直接点击顶部搜索区域的固定坐标
    log(`desktopSearch: 直接点击搜索区域坐标`);
    await ghostClickCoords(1400, 27, cfg);
  }
  await sleep(800);

  // 全选清空搜索框，输入自定义关键词
  log(`desktopSearch: 全选清空 + 输入 "${keyword}"`);
  await ghostHotkey(["cmd", "a"], cfg);
  await sleep(200);
  await ghostType(keyword, cfg);
  await sleep(500);

  // 执行搜索
  await ghostPress("return", cfg);
  await sleep(2500);

  // 读取搜索结果
  const { content } = await ghostRead(cfg, 80);
  const items = parseSearchItems(content);
  const screenshot = await ghostScreenshot(cfg).catch((err) => {
    log(`desktopSearch: 截图失败（${err}），继续返回文本数据`);
    return null;
  });

  log(`desktopSearch: DONE (${Date.now() - t0}ms) items=${items.length}`);
  return { items, screenshot, rawText: content };
}

/**
 * 获取小红书帖子详情（从当前列表中点击指定条目）。
 *
 * 桌面端没有 feedId/xsecToken，只能通过标题文本定位并点击。
 * 返回 AX 树原始文本 + 截图，让 Agent 做视觉分析。
 *
 * 操作流程：
 * 1. 在当前页面中查找目标标题
 * 2. 点击进入详情页
 * 3. 读取 AX 树提取内容
 * 4. 滚动加载评论
 * 5. 返回详情 + 截图
 */
export async function desktopGetFeed(
  titleQuery: string,
  cfg: GhostConfig = DEFAULT_GHOST_CONFIG,
  opts?: { scrollForComments?: boolean },
): Promise<DesktopFeedDetail> {
  const t0 = Date.now();
  log(`desktopGetFeed: START title="${titleQuery}"`);

  // 查找并点击目标帖子
  const elements = await ghostFind(titleQuery, cfg, { depth: 80 });
  if (elements.length > 0) {
    log(`desktopGetFeed: 找到 ${elements.length} 个匹配元素，点击第一个`);
    await ghostClickQuery(titleQuery, cfg);
  } else {
    log(`desktopGetFeed: 未找到匹配元素 "${titleQuery}"`);
    const screenshot = await ghostScreenshot(cfg).catch(() => null);
    return {
      rawText: `未找到标题包含 "${titleQuery}" 的帖子`,
      screenshot,
    };
  }

  await sleep(2000);

  // 读取详情页内容
  let { content } = await ghostRead(cfg, 100);

  // 滚动加载评论
  if (opts?.scrollForComments !== false) {
    for (let scroll = 0; scroll < 3; scroll++) {
      await ghostScroll("down", cfg, { amount: 5 });
      await sleep(1000);
    }
    const moreContent = await ghostRead(cfg, 100);
    content += "\n---滚动后---\n" + moreContent.content;
  }

  const screenshot = await ghostScreenshot(cfg).catch((err) => {
    log(`desktopGetFeed: 截图失败（${err}）`);
    return null;
  });

  log(`desktopGetFeed: DONE (${Date.now() - t0}ms)`);
  return { rawText: content, screenshot };
}

/**
 * 从帖子详情页返回列表页。
 */
export async function desktopGoBack(
  cfg: GhostConfig = DEFAULT_GHOST_CONFIG,
): Promise<void> {
  await navigateBack(cfg);
}
