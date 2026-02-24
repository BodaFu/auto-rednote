/**
 * browser.ts - 封装对 openclaw browser control 的调用
 *
 * 通过动态 import openclaw 内部 browser client 函数实现进程内调用。
 * 所有函数传入 baseUrl=undefined，触发 fetchBrowserJson 的进程内路由分支，
 * 无需独立 HTTP 端口。
 *
 * 默认使用 "openclaw" profile（openclaw 管理的隔离浏览器）。
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================================
// 配置
// ============================================================================

const XHS_HOME = "https://www.xiaohongshu.com";
const DEFAULT_PROFILE = "openclaw";

// ============================================================================
// 动态加载 openclaw 内部 browser client
//
// openclaw 的 browser client 函数接受 baseUrl: string | undefined。
// 传 undefined 时，fetchBrowserJson 走进程内路由（直接调用 dispatcher），
// 不需要独立 HTTP 端口。
// ============================================================================

type BrowserClientModule = typeof import("../../src/browser/client.js");
type BrowserActionsModule = typeof import("../../src/browser/client-actions-core.js");
type BrowserObserveModule = typeof import("../../src/browser/client-actions-observe.js");

let _client: BrowserClientModule | null = null;
let _actions: BrowserActionsModule | null = null;
let _observe: BrowserObserveModule | null = null;

/**
 * openclaw 根目录（在模块加载时计算）。
 *
 * 此文件位于 extensions/auto-rednote/src/browser.ts，
 * openclaw 根目录 = 上 3 层目录（src/ -> auto-rednote/ -> extensions/ -> openclaw/）。
 *
 * 在 gateway 进程中通过 jiti 加载此 .ts 文件时，
 * import.meta.url 指向源文件的实际路径，因此相对路径推算是可靠的。
 */
// browser.ts -> src/ -> auto-rednote/ -> extensions/ -> openclaw/
const OC_BASE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

async function getClient(): Promise<BrowserClientModule> {
  if (_client) return _client;
  _client = (await import(`${OC_BASE}/src/browser/client.ts`)) as BrowserClientModule;
  return _client;
}

async function getActions(): Promise<BrowserActionsModule> {
  if (_actions) return _actions;
  _actions = (await import(
    `${OC_BASE}/src/browser/client-actions-core.ts`
  )) as BrowserActionsModule;
  return _actions;
}

async function getObserve(): Promise<BrowserObserveModule> {
  if (_observe) return _observe;
  _observe = (await import(
    `${OC_BASE}/src/browser/client-actions-observe.ts`
  )) as BrowserObserveModule;
  return _observe;
}

// ============================================================================
// 标签页管理
// ============================================================================

export async function getTabs(
  profile?: string,
): Promise<Array<{ targetId: string; url: string; title?: string; type?: string }>> {
  const c = await getClient();
  return c.browserTabs(undefined, { profile: profile ?? DEFAULT_PROFILE });
}

export async function openTab(
  url: string,
  profile?: string,
): Promise<{ targetId: string; url: string }> {
  const c = await getClient();
  return c.browserOpenTab(undefined, url, { profile: profile ?? DEFAULT_PROFILE });
}

export async function closeTab(targetId: string, profile?: string): Promise<void> {
  const c = await getClient();
  return c.browserCloseTab(undefined, targetId, { profile: profile ?? DEFAULT_PROFILE });
}

// ============================================================================
// 页面操作
// ============================================================================

export async function navigate(
  targetId: string,
  url: string,
  profile?: string,
): Promise<{ targetId: string; url: string }> {
  const a = await getActions();
  return a.browserNavigate(undefined, { url, targetId, profile: profile ?? DEFAULT_PROFILE });
}

export type ActRequest =
  | { kind: "click"; ref: string; targetId?: string; doubleClick?: boolean; timeoutMs?: number }
  | {
      kind: "type";
      ref: string;
      text: string;
      targetId?: string;
      submit?: boolean;
      slowly?: boolean;
      timeoutMs?: number;
    }
  | { kind: "press"; key: string; targetId?: string; delayMs?: number }
  | { kind: "hover"; ref: string; targetId?: string; timeoutMs?: number }
  | { kind: "scrollIntoView"; ref: string; targetId?: string; timeoutMs?: number }
  | {
      kind: "fill";
      fields: Array<{ ref: string; type: string; value?: string | number | boolean }>;
      targetId?: string;
      timeoutMs?: number;
    }
  | { kind: "select"; ref: string; values: string[]; targetId?: string; timeoutMs?: number }
  | {
      kind: "wait";
      timeMs?: number;
      text?: string;
      textGone?: string;
      selector?: string;
      url?: string;
      loadState?: "load" | "domcontentloaded" | "networkidle";
      fn?: string;
      targetId?: string;
      timeoutMs?: number;
    }
  | { kind: "evaluate"; fn: string; ref?: string; targetId?: string; timeoutMs?: number }
  | { kind: "close"; targetId?: string };

export async function act(
  req: ActRequest,
  profile?: string,
): Promise<{ ok?: boolean; result?: unknown }> {
  const a = await getActions();
  return a.browserAct(undefined, req as Parameters<typeof a.browserAct>[1], {
    profile: profile ?? DEFAULT_PROFILE,
  });
}

export async function snapshot(
  targetId: string,
  opts?: { format?: "ai" | "aria"; selector?: string; profile?: string },
): Promise<{
  nodes?: Array<{ ref: string; role: string; name: string; value?: string }>;
  content?: string;
}> {
  const c = await getClient();
  return c.browserSnapshot(undefined, {
    format: opts?.format ?? "aria",
    targetId,
    selector: opts?.selector,
    profile: opts?.profile ?? DEFAULT_PROFILE,
  });
}

// ============================================================================
// 高级封装：evaluate JS
// ============================================================================

export async function evaluate(targetId: string, fn: string, profile?: string): Promise<unknown> {
  const res = await act({ kind: "evaluate", fn, targetId }, profile);
  return res.result;
}

// ============================================================================
// 高级封装：等待
// ============================================================================

export async function waitForSelector(
  targetId: string,
  selector: string,
  timeoutMs = 15000,
  profile?: string,
): Promise<void> {
  await act({ kind: "wait", selector, targetId, timeoutMs }, profile);
}

export async function waitForLoad(
  targetId: string,
  timeoutMs = 30000,
  profile?: string,
): Promise<void> {
  await act({ kind: "wait", loadState: "load", targetId, timeoutMs }, profile);
}

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// 高级封装：SPA 预热 + 导航
//
// 小红书是 SPA，直接导航目标页时 window.__INITIAL_STATE__ 可能未初始化。
// 策略：先确保有一个已访问首页的 tab，再导航到目标页。
// ============================================================================

let _warmupTabId: string | null = null;

export async function getOrCreateXhsTab(profile?: string): Promise<string> {
  const tabs = await getTabs(profile);

  // 优先复用已有的小红书 tab
  const existing = tabs.find(
    (t) => t.url.includes("xiaohongshu.com") && t.type !== "background_page",
  );
  if (existing) {
    _warmupTabId = existing.targetId;
    return existing.targetId;
  }

  // 新建 tab 并访问首页（SPA 预热）
  const tab = await openTab(XHS_HOME, profile);
  _warmupTabId = tab.targetId;
  await waitForLoad(tab.targetId, 20000, profile);
  await sleep(1500);
  return tab.targetId;
}

export async function navigateWithWarmup(
  url: string,
  profile?: string,
): Promise<{ targetId: string }> {
  const targetId = await getOrCreateXhsTab(profile);

  // 如果当前 tab 不在小红书，先访问首页预热
  const tabs = await getTabs(profile);
  const tab = tabs.find((t) => t.targetId === targetId);
  const isOnXhs = tab?.url.includes("xiaohongshu.com");

  if (!isOnXhs) {
    await navigate(targetId, XHS_HOME, profile);
    await waitForLoad(targetId, 20000, profile);
    await sleep(1000);
  }

  // 导航到目标页（忽略超时错误，页面可能加载慢但内容已可用）
  await navigate(targetId, url, profile).catch(() => null);
  await sleep(1500);

  return { targetId };
}

// ============================================================================
// 高级封装：提取 window.__INITIAL_STATE__
// ============================================================================

export async function extractInitialState(
  targetId: string,
  path: string,
  profile?: string,
): Promise<unknown> {
  const fn = `() => {
    try {
      const state = window.__INITIAL_STATE__;
      if (!state) return null;
      const parts = ${JSON.stringify(path)}.split('.');
      let cur = state;
      for (const p of parts) {
        if (cur == null) return null;
        cur = cur[p];
      }
      if (cur == null) return null;
      const val = cur._value !== undefined ? cur._value : (cur.value !== undefined ? cur.value : cur);
      return JSON.stringify(val);
    } catch (e) {
      return null;
    }
  }`;

  const result = await evaluate(targetId, fn, profile);
  if (typeof result !== "string" || !result) return null;
  try {
    return JSON.parse(result);
  } catch {
    return null;
  }
}

// ============================================================================
// 高级封装：等待 __INITIAL_STATE__ 中某个路径有值
// ============================================================================

export async function waitForInitialState(
  targetId: string,
  path: string,
  timeoutMs = 10000,
  profile?: string,
): Promise<unknown> {
  const fn = `() => {
    try {
      const state = window.__INITIAL_STATE__;
      if (!state) return false;
      const parts = ${JSON.stringify(path)}.split('.');
      let cur = state;
      for (const p of parts) {
        if (cur == null) return false;
        cur = cur[p];
      }
      const val = cur?._value !== undefined ? cur._value : (cur?.value !== undefined ? cur.value : cur);
      return val != null && (Array.isArray(val) ? val.length > 0 : true);
    } catch {
      return false;
    }
  }`;

  await act({ kind: "wait", fn, targetId, timeoutMs }, profile);
  return extractInitialState(targetId, path, profile);
}

// ============================================================================
// 高级封装：在 ARIA 快照中查找元素 ref
// ============================================================================

export async function findRef(
  targetId: string,
  matcher: (node: { ref: string; role: string; name: string; value?: string }) => boolean,
  profile?: string,
): Promise<string | null> {
  const snap = await snapshot(targetId, { format: "aria", profile });
  if (!snap.nodes) return null;
  const node = snap.nodes.find(matcher);
  return node?.ref ?? null;
}

export async function findRefByText(
  targetId: string,
  text: string,
  role?: string,
  profile?: string,
): Promise<string | null> {
  return findRef(
    targetId,
    (n) => n.name.includes(text) && (role ? n.role === role : true),
    profile,
  );
}

// ============================================================================
// 高级封装：文件选择器（用于上传图片/视频）
// ============================================================================

export async function armFileChooser(
  targetId: string,
  files: string[],
  ref?: string,
  profile?: string,
): Promise<void> {
  const a = await getActions();
  await a.browserArmFileChooser(undefined, {
    targetId,
    files,
    ref,
    profile: profile ?? DEFAULT_PROFILE,
  });
}

// ============================================================================
// 高级封装：等待并获取网络响应体
// ============================================================================

export interface ResponseBodyResult {
  url: string;
  status?: number;
  body: string;
}

export async function waitForResponseBody(
  targetId: string,
  urlPattern: string,
  timeoutMs = 15000,
  profile?: string,
): Promise<ResponseBodyResult> {
  const o = await getObserve();
  const res = await o.browserResponseBody(undefined, {
    url: urlPattern,
    targetId,
    timeoutMs,
    profile: profile ?? DEFAULT_PROFILE,
  });
  return {
    url: res.response.url,
    status: res.response.status,
    body: res.response.body,
  };
}
