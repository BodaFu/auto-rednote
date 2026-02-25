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
 * - 底部导航栏 Y 坐标基于 1512×949 窗口，可通过配置调整
 * - Agent 需要视觉分析（vision）能力来解析截图内容
 */

import type { PeekabooConfig, PeekabooElement, ScreenshotResult } from "./peekaboo.js";
import {
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

// ============================================================================
// 布局常量（1512×949 全屏窗口，窗口相对坐标）
// ============================================================================

/**
 * 底部导航栏五个 Tab 的中心坐标（窗口相对坐标）。
 *
 * 计算方式：窗口宽 1512 / 5 = 302.4px 每 Tab。
 * Y = 930（底部导航栏中心，距窗口顶部 930px，距窗口底部约 19px）。
 *
 * 这是窗口相对坐标（x=0,y=0 为窗口内容左上角），
 * clickCoords() 会自动加上屏幕偏移量（默认 y+=33，即绝对 y=963）。
 *
 * ⚠️ 仅适用于全屏模式（1512×949）。非全屏时坐标会漂移，必须保持全屏。
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
 * 返回按钮（左上角 < 箭头，窗口相对坐标）。
 * 实测：窗口内 x=20, y=30，绝对坐标 y=63。
 */
const BACK_BUTTON = { x: 20, y: 30 };

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

export interface ImOpenResult {
  /** 打开对话后的截图（包含消息历史）*/
  screenshot: ScreenshotResult;
  clickedAt?: { x: number; y: number };
}

export interface ImSendResult {
  /** 发送后的截图（用于验证消息已出现在对话中）*/
  screenshot: ScreenshotResult;
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
  // 操作前记录当前前台 App
  const previousApp = cfg.restoreApp ? getFrontmostApp() : null;
  try {
    return await fn();
  } finally {
    // 操作完成后切回（跳过小红书自身，避免切回到 discover/rednote）
    if (previousApp && previousApp !== cfg.processName && previousApp !== "rednote") {
      restoreFrontmostApp(previousApp);
    }
  }
}

// ============================================================================
// 核心操作
// ============================================================================

/**
 * 扫描未读私信（心跳专用）。
 *
 * 流程：
 * 1. 激活 App
 * 2. 点击底部「消息」Tab 导航到消息页
 * 3. 扫描 AX 树，提取未读角标信息
 * 4. 截图返回（Agent 需视觉分析具体哪条对话有未读）
 *
 * Agent 使用方式（心跳循环）：
 * 1. 调用此工具，获取截图 + unreadBadges
 * 2. 视觉分析截图，识别有未读消息的对话行及其坐标
 * 3. 调用 openConversation 打开对话
 * 4. 阅读截图中的消息内容
 * 5. 调用 sendMessage 回复
 */
export async function scanUnread(cfg: PeekabooConfig): Promise<ImUnreadResult> {
  return withRestore(cfg, async () => {
    activateApp(cfg);
    await sleep(800); // Space 切换动画需要约 700ms

    // 点击「消息」Tab
    clickCoords(BOTTOM_NAV.messages.x, BOTTOM_NAV.messages.y, cfg);
    await sleep(1200);

    // 截图（主要信息来源，Agent 通过视觉分析识别未读消息）
    const scr = screenshot(cfg);

    // 尝试扫描 AX 元素提取未读角标（peekaboo see 对 iOS App 可能超时，降级为空）
    let unreadBadges: Array<{ elemId: string; label: string; description: string }> = [];
    try {
      const { elements } = seeElements(cfg);
      unreadBadges = elements
        .filter(isUnreadBadge)
        .map((e) => ({ elemId: e.id, label: e.label ?? "", description: e.description ?? "" }));
    } catch {
      // peekaboo see 不可用（iOS App 兼容性问题），降级为纯视觉模式
    }

    return {
      screenshot: scr,
      unreadBadges,
      hasUnread: unreadBadges.length > 0,
      badgeCount: unreadBadges.length,
    };
  });
}

/**
 * 导航到消息收件箱并截图（通用收件箱查看）。
 * 与 scanUnread 类似，但不做未读过滤，适合查看全量消息列表。
 */
export async function getInbox(cfg: PeekabooConfig): Promise<ScreenshotResult> {
  return withRestore(cfg, async () => {
    activateApp(cfg);
    await sleep(800);

    clickCoords(BOTTOM_NAV.messages.x, BOTTOM_NAV.messages.y, cfg);
    await sleep(1000);

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
  waitMs = 1200,
): Promise<ImOpenResult> {
  if (!target.elemId && (target.x === undefined || target.y === undefined)) {
    throw new Error("必须提供 elemId 或 (x, y) 坐标之一");
  }

  return withRestore(cfg, async () => {
    activateApp(cfg);
    await sleep(800);

    let clickedAt: { x: number; y: number } | undefined;

    if (target.elemId) {
      const result = clickElement(target.elemId, cfg);
      if (result.clickLocation) clickedAt = result.clickLocation;
    } else {
      const x = target.x!;
      const y = target.y!;
      clickCoords(x, y, cfg);
      clickedAt = { x, y };
    }

    await sleep(waitMs);

    return { screenshot: screenshot(cfg), clickedAt };
  });
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

  return withRestore(cfg, async () => {
    activateApp(cfg);
    await sleep(800);

    // 点击输入框获取焦点
    clickCoords(INPUT_BOX.x, INPUT_BOX.y, cfg);
    await sleep(400);

    // 输入文字
    typeText(text, cfg);
    await sleep(300);

    // 发送
    pressKey("return", cfg);
    await sleep(800);

    return { screenshot: screenshot(cfg) };
  });
}

/**
 * 导航返回上一页（点击左上角 < 按钮）。
 * 用于从对话页返回消息列表，或从消息列表返回首页。
 */
export async function navigateBack(cfg: PeekabooConfig): Promise<ScreenshotResult> {
  return withRestore(cfg, async () => {
    activateApp(cfg);
    await sleep(800);

    clickCoords(BACK_BUTTON.x, BACK_BUTTON.y, cfg);
    await sleep(700);

    return screenshot(cfg);
  });
}

/**
 * 截图当前小红书桌面 App 界面。
 * 会切换到小红书 Space 截图，根据 cfg.restoreApp 决定是否切回。
 */
export async function takeScreenshot(cfg: PeekabooConfig): Promise<ScreenshotResult> {
  return withRestore(cfg, async () => screenshot(cfg));
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
    await sleep(800);

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
    await sleep(800);

    clickCoords(INPUT_BOX.x, INPUT_BOX.y, cfg);
    await sleep(300);

    hotkey("cmd,a", cfg);
    await sleep(100);
    pressKey("delete", cfg);
  });
}
