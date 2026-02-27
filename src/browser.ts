/**
 * browser.ts - 封装对 openclaw browser control 的调用
 *
 * 直接通过原生 fetch() 调用 Gateway 的浏览器控制 HTTP 服务，
 * 使用 process.env.OPENCLAW_GATEWAY_TOKEN 进行认证。
 *
 * 完全不依赖 jiti 动态导入 openclaw 内部模块，
 * 从根本上避免模块实例隔离导致的 Playwright 连接冲突。
 *
 * 默认使用 "openclaw" profile（openclaw 管理的隔离浏览器）。
 */

// ============================================================================
// 配置
// ============================================================================

const XHS_HOME = "https://www.xiaohongshu.com";
const DEFAULT_PROFILE = "openclaw";

const GATEWAY_PORT = Number(process.env.OPENCLAW_GATEWAY_PORT) || 18789;
const BROWSER_CONTROL_PORT = GATEWAY_PORT + 2;
const BROWSER_BASE_URL = `http://127.0.0.1:${BROWSER_CONTROL_PORT}`;

// ============================================================================
// HTTP 底层
// ============================================================================

function getAuthToken(): string | undefined {
  return process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || undefined;
}

function buildHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  const token = getAuthToken();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

function profileQuery(profile?: string): string {
  const p = profile ?? DEFAULT_PROFILE;
  return `?profile=${encodeURIComponent(p)}`;
}

async function browserFetch<T>(
  path: string,
  opts?: { method?: string; body?: unknown; timeoutMs?: number },
): Promise<T> {
  const timeoutMs = opts?.timeoutMs ?? 20000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);

  try {
    const init: RequestInit = {
      method: opts?.method ?? "GET",
      signal: ctrl.signal,
      headers: buildHeaders(
        opts?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
      ),
    };
    if (opts?.body !== undefined) {
      init.body = JSON.stringify(opts.body);
    }

    const res = await fetch(`${BROWSER_BASE_URL}${path}`, init);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(text || `HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================================
// 标签页管理
// ============================================================================

export async function getTabs(
  profile?: string,
): Promise<Array<{ targetId: string; url: string; title?: string; type?: string }>> {
  const res = await browserFetch<{ tabs: Array<{ targetId: string; url: string; title?: string; type?: string }> }>(
    `/tabs${profileQuery(profile)}`,
    { timeoutMs: 3000 },
  );
  return res.tabs;
}

export async function openTab(
  url: string,
  profile?: string,
): Promise<{ targetId: string; url: string }> {
  return browserFetch(`/tabs/open${profileQuery(profile)}`, {
    method: "POST",
    body: { url },
    timeoutMs: 15000,
  });
}

export async function closeTab(targetId: string, profile?: string): Promise<void> {
  await browserFetch(`/tabs/${encodeURIComponent(targetId)}${profileQuery(profile)}`, {
    method: "DELETE",
    timeoutMs: 5000,
  });
}

// ============================================================================
// 页面操作
// ============================================================================

export async function navigate(
  targetId: string,
  url: string,
  profile?: string,
): Promise<{ targetId: string; url: string }> {
  assertNotInCooldown();
  const result = await browserFetch<{ targetId: string; url: string }>(
    `/navigate${profileQuery(profile)}`,
    { method: "POST", body: { url, targetId }, timeoutMs: 20000 },
  );
  if (isRateLimitUrl(result.url)) {
    activateCooldown();
    await browserFetch(`/navigate${profileQuery(profile)}`, {
      method: "POST",
      body: { url: XHS_HOME, targetId },
      timeoutMs: 10000,
    }).catch(() => null);
    throw new RateLimitError(DEFAULT_COOLDOWN_MS);
  }
  return result;
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
  const timeoutMs = req.timeoutMs ?? 10000;
  return browserFetch(`/act${profileQuery(profile)}`, {
    method: "POST",
    body: req,
    timeoutMs,
  });
}

export async function snapshot(
  targetId: string,
  opts?: { format?: "ai" | "aria"; selector?: string; profile?: string },
): Promise<{
  nodes?: Array<{ ref: string; role: string; name: string; value?: string }>;
  content?: string;
}> {
  const params = new URLSearchParams();
  params.set("format", opts?.format ?? "aria");
  params.set("targetId", targetId);
  if (opts?.selector) params.set("selector", opts.selector);
  params.set("profile", opts?.profile ?? DEFAULT_PROFILE);
  return browserFetch(`/snapshot?${params.toString()}`, { timeoutMs: 20000 });
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
// 人类行为模拟工具
// ============================================================================

/**
 * 生成随机延迟时间（毫秒）
 * @param min 最小值（默认 3000ms）
 * @param max 最大值（默认 8000ms）
 */
export function randomDelay(min = 3000, max = 8000): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * 在小红书帖子详情页的正确滚动容器上派发 WheelEvent，触发评论懒加载。
 * 小红书的评论区在 .note-scroller 或 .interaction-container 内部滚动，
 * window.scrollBy 无法触发其 IntersectionObserver / scroll 事件。
 * 
 * @param deltaY 滚动像素量，正值向下
 */
export async function smartScroll(
  targetId: string,
  deltaY?: number,
  profile?: string,
): Promise<void> {
  const dy = deltaY ?? 600;
  await evaluate(
    targetId,
    `() => {
      const containers = ['.note-scroller', '.interaction-container', '#noteContainer'];
      let scrolled = false;
      for (const sel of containers) {
        const el = document.querySelector(sel);
        if (el && el.scrollHeight > el.clientHeight) {
          el.dispatchEvent(new WheelEvent('wheel', {
            deltaY: ${dy}, bubbles: true, cancelable: true
          }));
          el.scrollBy({ top: ${dy}, behavior: 'smooth' });
          scrolled = true;
          break;
        }
      }
      if (!scrolled) {
        window.scrollBy(0, ${dy});
      }
    }`,
    profile,
  ).catch(() => {});
}

/**
 * 模拟人类打开页面后的热身行为（滚动、停顿）
 */
export async function humanWarmup(
  targetId: string,
  profile?: string,
): Promise<void> {
  const scrollCount = Math.floor(Math.random() * 2) + 1;
  for (let i = 0; i < scrollCount; i++) {
    const dy = Math.floor(Math.random() * 300 + 100);
    await smartScroll(targetId, dy, profile);
    await sleep(randomDelay(500, 1500));
  }
}

// ============================================================================
// 导航保护：防止 xiaohongshu SPA 自动跳转到非 creator 页面
//
// creator.xiaohongshu.com 页面有前端脚本会自动导航到
// www.xiaohongshu.com/explore/... 上的笔记（通知/推荐），
// 导致发布流程中途页面丢失。
// 安装拦截器阻止所有非 creator 域名的 <a> 点击跳转。
// ============================================================================

export async function installNavigationGuard(targetId: string, profile?: string): Promise<void> {
  await evaluate(
    targetId,
    `() => {
      if (window.__oc_nav_guard) return;
      window.__oc_nav_guard = true;
      document.addEventListener('click', (e) => {
        const a = e.target.closest ? e.target.closest('a') : null;
        if (a && a.href && !a.href.includes('creator.xiaohongshu.com') && a.href !== '#' && !a.href.startsWith('javascript:')) {
          e.preventDefault();
          e.stopPropagation();
        }
      }, true);
      const origOpen = window.open;
      window.open = function(...args) {
        const url = String(args[0] || '');
        if (url && !url.includes('creator.xiaohongshu.com')) return null;
        return origOpen.apply(this, args);
      };
    }`,
    profile,
  );
}

// ============================================================================
// 高级封装：SPA 导航
//
// 策略：复用或新建 tab → 导航到 creator 发布页 → 安装导航保护
// ============================================================================

export async function getOrCreateXhsTab(profile?: string): Promise<string> {
  assertNotInCooldown();
  const tabs = await getTabs(profile);

  // 检查是否有 tab 停留在频率限制页面
  const limitedTab = tabs.find(
    (t) => t.type === "page" && isRateLimitUrl(t.url),
  );
  if (limitedTab) {
    activateCooldown();
    await browserFetch(`/navigate${profileQuery(profile)}`, {
      method: "POST",
      body: { url: XHS_HOME, targetId: limitedTab.targetId },
      timeoutMs: 10000,
    }).catch(() => null);
    throw new RateLimitError(DEFAULT_COOLDOWN_MS);
  }

  const existing = tabs.find(
    (t) => t.url.includes("xiaohongshu.com") && t.type !== "background_page" && t.type !== "service_worker",
  );
  if (existing) return existing.targetId;

  const tab = await openTab(XHS_HOME, profile);
  await waitForLoad(tab.targetId, 20000, profile);
  await sleep(500);
  await installNavigationGuard(tab.targetId, profile);
  return tab.targetId;
}

export async function navigateWithWarmup(
  url: string,
  profile?: string,
): Promise<{ targetId: string }> {
  assertNotInCooldown();
  const tabs = await getTabs(profile);

  // 检查是否有 tab 停留在频率限制页面
  const limitedTab = tabs.find(
    (t) => t.type === "page" && isRateLimitUrl(t.url),
  );
  if (limitedTab) {
    activateCooldown();
    await browserFetch(`/navigate${profileQuery(profile)}`, {
      method: "POST",
      body: { url: XHS_HOME, targetId: limitedTab.targetId },
      timeoutMs: 10000,
    }).catch(() => null);
    throw new RateLimitError(DEFAULT_COOLDOWN_MS);
  }

  const pageTabs = tabs.filter(
    (t) => t.url.includes("xiaohongshu.com") && t.type !== "background_page" && t.type !== "service_worker",
  );

  // 清理孤儿 about:blank tab，防止长期运行后内存泄漏
  const blankTabs = tabs.filter((t) => t.url === "about:blank" && t.type === "page");
  for (const bt of blankTabs) {
    await closeTab(bt.targetId, profile).catch(() => null);
  }

  let targetId: string;

  if (pageTabs.length > 0) {
    targetId = pageTabs[0]!.targetId;
    for (let i = 1; i < pageTabs.length; i++) {
      await closeTab(pageTabs[i]!.targetId, profile).catch(() => null);
    }
  } else {
    const tab = await openTab("about:blank", profile);
    targetId = tab.targetId;
  }

  // navigate 内部已包含频率限制检测，RateLimitError 会直接抛出
  await navigate(targetId, url, profile).catch((err) => {
    if (isRateLimitError(err)) throw err;
  });
  await sleep(randomDelay(2000, 4000));

  // 导航后再次检查（某些限制是异步跳转的）
  const currentUrl = (await evaluate(targetId, "() => window.location.href", profile).catch(() => "")) as string;
  if (isRateLimitUrl(currentUrl)) {
    activateCooldown();
    await browserFetch(`/navigate${profileQuery(profile)}`, {
      method: "POST",
      body: { url: XHS_HOME, targetId },
      timeoutMs: 10000,
    }).catch(() => null);
    throw new RateLimitError(DEFAULT_COOLDOWN_MS);
  }

  const urlHost = new URL(url).hostname;
  if (!currentUrl?.includes(urlHost)) {
    await navigate(targetId, url, profile).catch((err) => {
      if (isRateLimitError(err)) throw err;
    });
    await sleep(randomDelay(2000, 4000));
  }

  await humanWarmup(targetId, profile).catch(() => {});
  await installNavigationGuard(targetId, profile);

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
      function unwrap(obj, depth) {
        if (depth > 8 || obj == null || typeof obj !== 'object') return obj;
        var v = obj._value !== undefined ? obj._value : (obj.value !== undefined && !Array.isArray(obj) && typeof obj.value !== 'string' ? obj.value : obj);
        if (v !== obj) return unwrap(v, depth + 1);
        if (Array.isArray(v)) return v.map(function(item) { return unwrap(item, depth + 1); });
        var result = {};
        var keys = Object.keys(v);
        for (var i = 0; i < keys.length; i++) {
          result[keys[i]] = unwrap(v[keys[i]], depth + 1);
        }
        return result;
      }
      const state = window.__INITIAL_STATE__;
      if (!state) return null;
      const parts = ${JSON.stringify(path)}.split('.');
      let cur = state;
      for (const p of parts) {
        if (cur == null) return null;
        cur = cur[p];
      }
      if (cur == null) return null;
      return JSON.stringify(unwrap(cur, 0));
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
      function unwrapCheck(obj, depth) {
        if (depth > 8 || obj == null || typeof obj !== 'object') return obj;
        if (obj._value !== undefined) return unwrapCheck(obj._value, depth + 1);
        if (obj.value !== undefined && !Array.isArray(obj) && typeof obj.value !== 'string') return unwrapCheck(obj.value, depth + 1);
        return obj;
      }
      const state = window.__INITIAL_STATE__;
      if (!state) return false;
      const parts = ${JSON.stringify(path)}.split('.');
      let cur = state;
      for (const p of parts) {
        if (cur == null) return false;
        cur = cur[p];
      }
      const val = unwrapCheck(cur, 0);
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
  opts?: { ref?: string; element?: string; inputRef?: string; profile?: string },
): Promise<void> {
  await browserFetch(`/hooks/file-chooser${profileQuery(opts?.profile)}`, {
    method: "POST",
    body: {
      targetId,
      paths: files,
      ref: opts?.ref,
      inputRef: opts?.inputRef,
      element: opts?.element,
    },
    timeoutMs: 20000,
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
  const res = await browserFetch<{
    ok: boolean;
    targetId: string;
    response: { url: string; status?: number; body: string };
  }>(`/response/body${profileQuery(profile)}`, {
    method: "POST",
    body: { targetId, url: urlPattern, timeoutMs },
    timeoutMs: timeoutMs + 5000,
  });
  return {
    url: res.response.url,
    status: res.response.status,
    body: res.response.body,
  };
}

// ============================================================================
// 错误检测 & Tab 健康检查
// ============================================================================

export function isTabLostError(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  return (
    msg.includes("tab not found") ||
    msg.includes("no attached chrome tabs") ||
    msg.includes("extension disconnected") ||
    msg.includes("browser not started") ||
    (msg.includes("can't reach") && msg.includes("browser control"))
  );
}

export async function isTabAlive(targetId: string, profile?: string): Promise<boolean> {
  try {
    const tabs = await getTabs(profile);
    return tabs.some((t) => t.targetId === targetId);
  } catch {
    return false;
  }
}

// ============================================================================
// 频率限制检测 & 冷却机制
//
// 小红书在访问过于频繁时会将页面重定向到两种限制页面：
// 1. /website-login/error?...error_code=300013  → "安全限制：访问频繁"
// 2. /404?source=/404/sec_...&error_code=300031 → "当前笔记暂时无法浏览"
//
// 检测到后进入冷却期（默认 10 分钟），期间所有小红书操作直接拒绝。
// ============================================================================

const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;

let rateLimitCooldownUntil = 0;

export class RateLimitError extends Error {
  public readonly cooldownUntil: number;
  public readonly remainingMs: number;

  constructor(remainingMs: number) {
    const minutes = Math.ceil(remainingMs / 60_000);
    super(`小红书访问频率限制中，请 ${minutes} 分钟后再试`);
    this.name = "RateLimitError";
    this.cooldownUntil = Date.now() + remainingMs;
    this.remainingMs = remainingMs;
  }
}

export function isRateLimitError(err: unknown): err is RateLimitError {
  return err instanceof RateLimitError;
}

/**
 * 检查 URL 是否为小红书频率限制页面。
 */
function isRateLimitUrl(url: string): boolean {
  if (!url) return false;
  return (
    (url.includes("/website-login/error") && url.includes("300013")) ||
    (url.includes("/404") && url.includes("/sec_") && url.includes("300031"))
  );
}

/**
 * 触发冷却期。导航回首页以恢复正常状态。
 */
function activateCooldown(cooldownMs = DEFAULT_COOLDOWN_MS): void {
  rateLimitCooldownUntil = Date.now() + cooldownMs;
}

/**
 * 检查是否处于冷却期。如果是，抛出 RateLimitError。
 * 所有小红书操作入口应在执行前调用此函数。
 */
export function assertNotInCooldown(): void {
  const remaining = rateLimitCooldownUntil - Date.now();
  if (remaining > 0) {
    throw new RateLimitError(remaining);
  }
}

/**
 * 检测当前页面是否为频率限制页面。
 * 如果是，激活冷却期并尝试导航回首页。
 */
export async function checkRateLimit(targetId: string, profile?: string): Promise<void> {
  const currentUrl = await evaluate(targetId, "() => window.location.href", profile)
    .catch(() => "") as string;

  if (isRateLimitUrl(currentUrl)) {
    activateCooldown();
    // 尝试导航回首页，避免下次操作时仍停留在限制页面
    await navigate(targetId, XHS_HOME, profile).catch(() => null);
    throw new RateLimitError(DEFAULT_COOLDOWN_MS);
  }
}

/**
 * 检查 tabs 列表中是否有处于频率限制页面的 tab。
 * 用于 getOrCreateXhsTab / navigateWithWarmup 等获取 tab 时的早期检测。
 */
export async function checkTabsForRateLimit(profile?: string): Promise<void> {
  const tabs = await getTabs(profile);
  const limitedTab = tabs.find(
    (t) => t.type === "page" && isRateLimitUrl(t.url),
  );
  if (limitedTab) {
    activateCooldown();
    await navigate(limitedTab.targetId, XHS_HOME, profile).catch(() => null);
    throw new RateLimitError(DEFAULT_COOLDOWN_MS);
  }
}
