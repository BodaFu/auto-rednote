/**
 * im.ts - 小红书桌面 App IM 操作（私信 + 群聊）
 *
 * 基于 peekaboo CLI，实现对小红书 iOS on macOS App 的私信操作：
 * - 扫描未读消息（心跳）
 * - 导航到消息收件箱
 * - 打开指定对话
 * - 发送消息
 * - 截图当前状态
 * - 获取 UI 元素列表
 *
 * 技术说明：
 * - 小红书 macOS App 是 iOS 移植版（非 Electron），CDP 不可用
 * - AX 树质量低（大多数元素标签为"按钮"/"文本"），读取消息内容依赖视觉截图
 * - 所有坐标均为实测硬编码值，基于 1512×949 全屏窗口
 * - Agent 只需提供回复文本，坐标导航逻辑全部封装在代码中
 */

import type { PeekabooConfig, PeekabooElement, ScreenshotResult } from "./peekaboo.js";
import {
  SPACE_SWITCH_WAIT_MS,
  activateApp,
  clickCoords,
  clickElement,
  getFrontmostApp,
  hotkey,
  pressKey,
  restoreFrontmostApp,
  screenshot,
  seeElements,
  sleep,
  typeText,
} from "./peekaboo.js";

const TAG = "[desktop-im]";
function log(...args: unknown[]): void {
  console.error(TAG, ...args);
}

// ============================================================================
// 布局常量（1512×949 全屏窗口，窗口相对坐标，全部实测）
// ============================================================================

/**
 * 底部导航栏五个 Tab 的中心坐标（窗口相对坐标）。
 * ⚠️ 仅适用于全屏模式（1512×949）。
 */
const BOTTOM_NAV = {
  home: { x: 151, y: 930 },
  market: { x: 453, y: 930 },
  post: { x: 756, y: 930 },
  messages: { x: 1058, y: 930 },
  profile: { x: 1360, y: 930 },
} as const;

/**
 * 私信输入框坐标（聊天页面底部，窗口相对坐标）。
 * 实测：窗口内 y=930，绝对坐标 y=963。
 * 点击后用 peekaboo type 输入文字，peekaboo press return 发送。
 */
const INPUT_BOX = { x: 756, y: 930 };

/**
 * 消息列表布局常量（消息 Tab 页面）。
 *
 * 消息列表页面结构（全屏 1512×949）：
 *   y=0~95:    顶部图标区（赞和收藏 / 新增关注 / 评论和@）
 *   y≈100~900: 消息列表区域（所有对话 + 陌生人消息入口，按时间排序）
 *   y≈910~949: 底部导航栏
 *
 * ⚠️ 「陌生人消息」不在固定位置！它按时间排序混在普通对话中间。
 * 必须通过视觉分析截图识别「陌生人消息」在哪一行。
 *
 * 陌生人消息列表页面结构（点击进入后的子页面）：
 *   每行高度约 56 逻辑像素
 *   「回复」按钮在每行左下角，x≈88
 */
const MSG_LIST = {
  /** 消息列表第一行中心 Y（图标区下方第一条） */
  firstRowCenterY: 130,
  /** 消息列表行高（逻辑像素，实测约 67px） */
  rowHeight: 67,
  /** 消息列表行中心 X */
  rowCenterX: 512,
  /** 最大可见消息行数（不滚动，包含陌生人消息入口） */
  maxVisibleRows: 11,
} as const;

const STRANGER_LIST = {
  /** 陌生人消息列表「回复」按钮第一条的 Y 坐标（实测） */
  replyBtnYFirst: 81,
  /** 陌生人消息列表行高（逻辑像素，实测） */
  rowHeight: 56,
  /** 「回复」按钮 X 坐标（固定在左侧） */
  replyBtnX: 88,
  /** 最大可见陌生人消息行数（不滚动） */
  maxVisibleRows: 8,
} as const;

/**
 * 返回按钮坐标（左上角 < 箭头，窗口相对坐标）。
 * 实测：全屏模式下左上角导航返回按钮。
 */
const BACK_BUTTON = { x: 20, y: 30 } as const;

// ============================================================================
// 结果类型
// ============================================================================

export interface ImUnreadResult {
  /** 当前收件箱截图（用于 Agent 视觉分析消息列表）*/
  screenshot: ScreenshotResult;
  /**
   * 从 AX 树中检测到的未读标志（iOS App AX 质量低，不一定完整）。
   * 通常包含底部导航 Tab 的角标，如 { elemId: "elem_8", label: "2条未读" }。
   * Agent 应结合截图视觉分析来识别具体哪条对话有未读消息。
   */
  unreadBadges: Array<{ elemId: string; label: string; description: string }>;
  hasUnread: boolean;
  /** AX 树检测到的未读角标数量（非消息数，是角标 UI 元素数量）*/
  badgeCount: number;
}

/** 消息列表中单行的描述（硬编码坐标） */
export interface ImRowEntry {
  /** 点击坐标（窗口相对逻辑像素） */
  clickX: number;
  clickY: number;
  /** 在列表中的序号（从 1 开始） */
  row: number;
}

/** scanInbox 的返回结果 */
export interface ImInboxScanResult {
  /** 消息列表截图（Agent 用于视觉确认） */
  screenshot: ScreenshotResult;
  /**
   * 消息列表中所有可见行的预计算坐标（硬编码）。
   * 包含普通对话行和「陌生人消息」入口（它们按时间排序混在一起）。
   * Agent 需视觉分析截图，识别每行内容，然后用对应行的 clickX/clickY。
   */
  visibleRows: ImRowEntry[];
  /** AX 树检测到的未读角标（辅助，不一定完整） */
  unreadBadges: Array<{ elemId: string; label: string }>;
  /** AX 树是否检测到未读（辅助判断，仍需视觉确认） */
  hasUnread: boolean;
}

/** scanStrangerList 的返回结果 */
export interface ImStrangerListResult {
  /** 陌生人消息列表截图（Agent 用于视觉确认是否有消息） */
  screenshot: ScreenshotResult;
  /**
   * 陌生人消息列表中可见行的「回复」按钮坐标（硬编码）。
   * Agent 需视觉分析截图，判断列表是否为空，
   * 如果有消息，依次用这些坐标调用 openConversation 打开对话。
   */
  replyButtons: ImRowEntry[];
  /** AX 树是否检测到「回复」按钮（辅助判断列表是否为空） */
  hasReplyButtons: boolean;
  /** AX 树检测到的元素总数 */
  axElementCount: number;
}

export interface ImOpenResult {
  /** 打开对话后的截图（包含消息历史）*/
  screenshot: ScreenshotResult;
  clickedAt?: { x: number; y: number };
}

export interface ImSendResult {
  /** 已发送的文本 */
  sentText: string;
  /** 字符数 */
  charCount: number;
}

export interface ImSeeResult {
  screenshot: ScreenshotResult;
  elements: PeekabooElement[];
  interactableElements: PeekabooElement[];
  elementCount: number;
  interactableCount: number;
  snapshotId: string;
}

// ============================================================================
// 内部辅助
// ============================================================================

/** 检查元素是否为"未读"角标（包含"未读"字样且可交互）*/
function isUnreadBadge(e: PeekabooElement): boolean {
  return Boolean(e.label?.includes("未读") && e.is_actionable);
}

/**
 * 执行一段操作，完成后根据 cfg.restoreApp 决定是否切回原前台 App。
 *
 * 在整个操作序列（activate → 点击/输入/截图）完成后统一切回，
 * 避免中途切回导致后续操作点错 App。
 */
async function withRestore<T>(cfg: PeekabooConfig, fn: () => Promise<T>): Promise<T> {
  const previousApp = cfg.restoreApp ? getFrontmostApp() : null;
  log(`withRestore: restoreApp=${cfg.restoreApp} previousApp="${previousApp ?? "none"}"`);
  try {
    return await fn();
  } finally {
    if (previousApp && previousApp !== cfg.processName && previousApp !== "rednote") {
      restoreFrontmostApp(previousApp);
    } else {
      log("withRestore: skip restore (restoreApp off or same app)");
    }
  }
}

// ============================================================================
// 核心操作
// ============================================================================

/**
 * 扫描消息列表，返回所有可见行的硬编码坐标。
 *
 * ⚠️ 「陌生人消息」入口不在固定位置，按时间排序混在普通对话中间。
 *
 * Agent 使用方式：
 * 1. 调用此函数，获取截图 + visibleRows
 * 2. 视觉分析截图，识别每行内容：有未读的普通对话、「陌生人消息」入口
 * 3. 用对应行的 visibleRows[N].clickX/Y 调用 openConversation
 */
export async function scanInbox(cfg: PeekabooConfig): Promise<ImInboxScanResult> {
  const t0 = Date.now();
  log("scanInbox: START");
  const result = await withRestore(cfg, async () => {
    log("scanInbox: activateApp");
    activateApp(cfg);
    await sleep(SPACE_SWITCH_WAIT_MS);

    log(`scanInbox: click messages tab (${BOTTOM_NAV.messages.x},${BOTTOM_NAV.messages.y})`);
    clickCoords(BOTTOM_NAV.messages.x, BOTTOM_NAV.messages.y, cfg);
    await sleep(500);

    log("scanInbox: screenshot");
    const scr = screenshot(cfg);

    // AX 树辅助检测未读角标（可能超时，不阻塞主流程）
    let unreadBadges: Array<{ elemId: string; label: string }> = [];
    try {
      const { elements } = seeElements(cfg);
      unreadBadges = elements
        .filter(isUnreadBadge)
        .map((e) => ({ elemId: e.id, label: e.label ?? "" }));
      log(`scanInbox: AX tree found ${unreadBadges.length} unread badges`);
    } catch (err) {
      log(`scanInbox: AX tree failed (${err})`);
    }

    // 统一生成所有可见行的坐标（包含普通对话和陌生人消息入口）
    const visibleRows: ImRowEntry[] = Array.from(
      { length: MSG_LIST.maxVisibleRows },
      (_, i) => ({
        clickX: MSG_LIST.rowCenterX,
        clickY: MSG_LIST.firstRowCenterY + i * MSG_LIST.rowHeight,
        row: i + 1,
      }),
    );

    return {
      screenshot: scr,
      visibleRows,
      unreadBadges,
      hasUnread: unreadBadges.length > 0,
    };
  });
  log(`scanInbox: DONE (${Date.now() - t0}ms) rows=${result.visibleRows.length} hasUnread=${result.hasUnread}`);
  return result;
}

/**
 * 扫描陌生人消息列表，返回硬编码的「回复」按钮坐标列表。
 *
 * 前置条件：当前界面必须已通过「陌生人消息」行坐标进入陌生人消息列表页。
 *
 * Agent 使用方式：
 * 1. 调用此函数，获取截图 + replyButtons
 * 2. 视觉分析截图，判断列表是否为空
 * 3. 如果有消息，依次用 replyButtons[i].clickX/Y 调用 openConversation
 *
 * 注意：replyButtons 包含所有可见行的坐标。
 * 是否有消息需要视觉分析截图判断（列表为空时截图会显示空状态）。
 */
export async function scanStrangerList(cfg: PeekabooConfig): Promise<ImStrangerListResult> {
  const t0 = Date.now();
  log("scanStrangerList: START");
  const result = await withRestore(cfg, async () => {
    activateApp(cfg);
    await sleep(SPACE_SWITCH_WAIT_MS);

    log("scanStrangerList: screenshot");
    const scr = screenshot(cfg);

    // AX 树辅助检测是否有「回复」按钮（判断列表是否为空）
    let hasReplyButtons = false;
    let axElementCount = 0;
    try {
      const { elements } = seeElements(cfg);
      axElementCount = elements.length;
      hasReplyButtons = elements.some(
        (e) => e.label?.includes("回复") || e.description?.includes("回复"),
      );
      log(`scanStrangerList: AX tree ${axElementCount} elements, hasReplyButtons=${hasReplyButtons}`);
    } catch (err) {
      log(`scanStrangerList: AX tree failed (${err})`);
    }

    const replyButtons: ImRowEntry[] = Array.from(
      { length: STRANGER_LIST.maxVisibleRows },
      (_, i) => ({
        clickX: STRANGER_LIST.replyBtnX,
        clickY: STRANGER_LIST.replyBtnYFirst + i * STRANGER_LIST.rowHeight,
        row: i + 1,
      }),
    );

    return { screenshot: scr, replyButtons, hasReplyButtons, axElementCount };
  });
  log(`scanStrangerList: DONE (${Date.now() - t0}ms) hasReplyButtons=${result.hasReplyButtons}`);
  return result;
}

/**
 * 扫描未读私信（心跳专用，旧版接口保留兼容）。
 *
 * 流程：
 * 1. 激活 App
 * 2. 点击底部「消息」Tab 导航到消息页
 * 3. 扫描 AX 树，提取未读角标信息
 * 4. 截图返回（Agent 需视觉分析具体哪条对话有未读）
 *
 * 推荐使用 scanInbox() 替代此函数，它返回更完整的硬编码坐标信息。
 */
export async function scanUnread(cfg: PeekabooConfig): Promise<ImUnreadResult> {
  const t0 = Date.now();
  log("scanUnread: START");
  const result = await withRestore(cfg, async () => {
    activateApp(cfg);
    await sleep(SPACE_SWITCH_WAIT_MS);

    log(`scanUnread: click messages tab (${BOTTOM_NAV.messages.x},${BOTTOM_NAV.messages.y})`);
    clickCoords(BOTTOM_NAV.messages.x, BOTTOM_NAV.messages.y, cfg);
    await sleep(500);

    const scr = screenshot(cfg);

    let unreadBadges: Array<{ elemId: string; label: string; description: string }> = [];
    try {
      const { elements } = seeElements(cfg);
      unreadBadges = elements
        .filter(isUnreadBadge)
        .map((e) => ({ elemId: e.id, label: e.label ?? "", description: e.description ?? "" }));
      log(`scanUnread: AX tree found ${unreadBadges.length} unread badges`);
    } catch (err) {
      log(`scanUnread: AX tree failed (${err}), falling back to visual-only`);
    }

    return {
      screenshot: scr,
      unreadBadges,
      hasUnread: unreadBadges.length > 0,
      badgeCount: unreadBadges.length,
    };
  });
  log(`scanUnread: DONE hasUnread=${result.hasUnread} badges=${result.badgeCount} (${Date.now() - t0}ms)`);
  return result;
}

/**
 * 导航到消息收件箱并截图（通用收件箱查看）。
 * 与 scanUnread 类似，但不做未读过滤，适合查看全量消息列表。
 */
export async function getInbox(cfg: PeekabooConfig): Promise<ScreenshotResult> {
  return withRestore(cfg, async () => {
    activateApp(cfg);
    await sleep(SPACE_SWITCH_WAIT_MS);

    clickCoords(BOTTOM_NAV.messages.x, BOTTOM_NAV.messages.y, cfg);
    await sleep(500);

    return screenshot(cfg);
  });
}

/**
 * 打开一条私信对话。
 *
 * 支持两种定位方式（二选一）：
 * - elemId: 使用 seeElements 返回的元素 ID（最稳定）
 * - x + y:  截图中的坐标（Agent 从视觉分析中获取）
 *
 * @param waitMs 点击后等待页面加载的毫秒数，默认 1200ms
 */
export async function openConversation(
  target: { elemId?: string; x?: number; y?: number },
  cfg: PeekabooConfig,
  waitMs = 600,
): Promise<ImOpenResult> {
  if (!target.elemId && (target.x === undefined || target.y === undefined)) {
    throw new Error("必须提供 elemId 或 (x, y) 坐标之一");
  }

  const t0 = Date.now();
  log(`openConversation: START target=${JSON.stringify(target)} waitMs=${waitMs}`);
  const result = await withRestore(cfg, async () => {
    activateApp(cfg);
    await sleep(SPACE_SWITCH_WAIT_MS);

    let clickedAt: { x: number; y: number } | undefined;

    if (target.elemId) {
      log(`openConversation: clickElement elemId="${target.elemId}"`);
      const result = clickElement(target.elemId, cfg);
      if (result.clickLocation) clickedAt = result.clickLocation;
    } else {
      const x = target.x!;
      const y = target.y!;
      log(`openConversation: clickCoords (${x},${y})`);
      clickCoords(x, y, cfg);
      clickedAt = { x, y };
    }

    log(`openConversation: waiting ${waitMs}ms for page load`);
    await sleep(waitMs);

    log("openConversation: screenshot");
    return { screenshot: screenshot(cfg), clickedAt };
  });
  log(`openConversation: DONE clickedAt=(${result.clickedAt?.x},${result.clickedAt?.y}) (${Date.now() - t0}ms)`);
  return result;
}

/**
 * 在当前打开的对话中发送一条私信。
 *
 * 流程：
 * 1. 激活 App
 * 2. 点击底部输入框获取焦点
 * 3. 输入文字
 * 4. 按 Return 发送
 * 5. 截图确认
 *
 * 前置条件：当前界面必须已打开某个私信对话（输入框可见）。
 */
export async function sendMessage(text: string, cfg: PeekabooConfig): Promise<ImSendResult> {
  if (!text.trim()) throw new Error("消息内容不能为空");

  const t0 = Date.now();
  log(`sendMessage: START text="${text.slice(0, 50)}${text.length > 50 ? "..." : ""}" (${text.length} chars)`);
  await withRestore(cfg, async () => {
    activateApp(cfg);
    await sleep(SPACE_SWITCH_WAIT_MS);

    log(`sendMessage: click input box (${INPUT_BOX.x},${INPUT_BOX.y})`);
    clickCoords(INPUT_BOX.x, INPUT_BOX.y, cfg);
    await sleep(200);

    log("sendMessage: typeText");
    typeText(text, cfg);
    await sleep(150);

    log("sendMessage: press return");
    pressKey("return", cfg);
    await sleep(300);
  });
  log(`sendMessage: DONE (${Date.now() - t0}ms)`);
  return { sentText: text, charCount: text.length };
}

/**
 * 导航返回上一页（点击左上角 < 按钮）。
 * 用于从对话页返回消息列表，或从消息列表返回首页。
 */
export interface ImBackResult {
  /** 点击的返回按钮坐标 */
  clickedAt: { x: number; y: number };
}

export async function navigateBack(cfg: PeekabooConfig): Promise<ImBackResult> {
  const t0 = Date.now();
  log(`navigateBack: START click=(${BACK_BUTTON.x},${BACK_BUTTON.y})`);
  await withRestore(cfg, async () => {
    activateApp(cfg);
    await sleep(SPACE_SWITCH_WAIT_MS);

    clickCoords(BACK_BUTTON.x, BACK_BUTTON.y, cfg);
    await sleep(300);
  });
  log(`navigateBack: DONE (${Date.now() - t0}ms)`);
  return { clickedAt: { x: BACK_BUTTON.x, y: BACK_BUTTON.y } };
}

/**
 * 截图当前小红书桌面 App 界面。
 * 会切换到小红书 Space 截图，根据 cfg.restoreApp 决定是否切回。
 */
export async function takeScreenshot(cfg: PeekabooConfig): Promise<ScreenshotResult> {
  log("takeScreenshot: START");
  const t0 = Date.now();
  const result = await withRestore(cfg, async () => {
    activateApp(cfg);
    await sleep(SPACE_SWITCH_WAIT_MS);
    return screenshot(cfg);
  });
  log(`takeScreenshot: DONE (${Date.now() - t0}ms)`);
  return result;
}

/**
 * 获取当前界面的 UI 元素列表（含截图）。
 * 用于：
 * - 动态查找可点击元素的 elemId（如未读角标、导航按钮）
 * - 调试/验证当前 App 状态
 *
 * 注意：iOS App AX 树质量低，多数元素 label 为泛型（"按钮"/"文本"），
 * 有意义的元素通常是导航相关（"X条未读"等）。
 */
export async function getCurrentElements(cfg: PeekabooConfig): Promise<ImSeeResult> {
  return withRestore(cfg, async () => {
    activateApp(cfg);
    await sleep(SPACE_SWITCH_WAIT_MS);

    const scr = screenshot(cfg);

    let seeResult = {
      elements: [] as PeekabooElement[],
      elementCount: 0,
      interactableCount: 0,
      snapshotId: "",
    };
    try {
      seeResult = seeElements(cfg);
    } catch {
      // 降级：仅返回截图，元素列表为空
    }

    return {
      screenshot: scr,
      elements: seeResult.elements,
      interactableElements: seeResult.elements.filter((e) => e.is_actionable),
      elementCount: seeResult.elementCount,
      interactableCount: seeResult.interactableCount,
      snapshotId: seeResult.snapshotId,
    };
  });
}

/**
 * 清空当前输入框内容（用于修正错误输入）。
 * 全选 + Delete。
 */
export async function clearInput(cfg: PeekabooConfig): Promise<void> {
  return withRestore(cfg, async () => {
    activateApp(cfg);
    await sleep(SPACE_SWITCH_WAIT_MS);

    clickCoords(INPUT_BOX.x, INPUT_BOX.y, cfg);
    await sleep(150);

    hotkey("cmd,a", cfg);
    await sleep(80);
    pressKey("delete", cfg);
  });
}
