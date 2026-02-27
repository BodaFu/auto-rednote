/**
 * ghost.ts - Ghost OS CLI 封装层
 *
 * 通过 MCP JSON-RPC 协议调用 Ghost OS（ghost mcp），
 * 实现对小红书桌面 App（iOS on macOS）的 AX 树读取和 GUI 操作。
 *
 * Ghost OS 优势（相比 peekaboo）：
 * - ghost_read 能深度遍历 AX 树，提取丰富的文本内容（标题、作者、时间、互动数据）
 * - 感知工具（read/find/context）从后台工作，不需要切换 Space/focus
 * - 操作工具（click/type）先尝试 AX-native，失败后自动降级为 synthetic
 * - ghost_wait 支持条件等待，避免固定 sleep
 *
 * 坐标系说明：
 * - Ghost OS 使用屏幕绝对坐标（与 macOS 坐标系一致）
 * - 小红书全屏窗口：x=0, y=33（菜单栏下方），w=1512, h=949
 * - 本模块对外暴露窗口相对坐标（x=0,y=0 为窗口内容左上角），内部自动转换
 */

import { spawn, spawnSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TAG = "[ghost]";
function log(...args: unknown[]): void {
  console.error(TAG, ...args);
}

// ============================================================================
// 配置
// ============================================================================

export interface GhostConfig {
  /** ghost 二进制路径 */
  bin: string;
  /** App 名称（Ghost OS 中的名称） */
  appName: string;
  /** 内部进程名（用于 osascript activate 切换 Space），默认 discover */
  processName: string;
  /** 窗口在屏幕上的偏移（用于坐标转换） */
  windowOffset: { x: number; y: number };
  /** AX 树读取深度 */
  readDepth: number;
}

export const DEFAULT_GHOST_CONFIG: GhostConfig = {
  bin: "/opt/homebrew/bin/ghost",
  appName: "rednote",
  processName: "discover",
  windowOffset: { x: 0, y: 33 },
  readDepth: 50,
};

// ============================================================================
// App 激活（Space 切换）— 仅在需要手动切换 Space 时使用
// ============================================================================

/**
 * 通过 osascript 激活小红书 App，触发 macOS Space 切换。
 *
 * 注意：Ghost OS 的 ghost_click 等交互工具自带 app 参数会内部处理 focus，
 * 不需要额外调用此函数。仅在特殊场景（如截图前需要切换到 App 的 Space）时使用。
 */
export function activateApp(cfg: GhostConfig = DEFAULT_GHOST_CONFIG): void {
  const result = spawnSync("osascript", [
    "-e",
    `tell application "${cfg.processName}" to activate`,
  ], { timeout: 3000 });
  if (result.status !== 0) {
    log(`activateApp: osascript 失败: ${result.stderr?.toString()}`);
  }
}

// ============================================================================
// MCP JSON-RPC 通信层
// ============================================================================

let requestId = 0;

/**
 * 调用 Ghost OS MCP 工具。
 *
 * 每次调用启动一个 `ghost mcp` 子进程，发送单条 JSON-RPC 请求后关闭。
 * 虽然每次启动进程有 ~100ms 开销，但避免了长连接管理的复杂性，
 * 且 Ghost OS 的 Swift 二进制启动非常快。
 */
async function callGhostTool<T = unknown>(
  toolName: string,
  args: Record<string, unknown>,
  cfg: GhostConfig,
  timeoutMs = 15_000,
): Promise<T> {
  const id = ++requestId;
  const request = JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: toolName, arguments: args },
  });

  const t0 = Date.now();

  return new Promise<T>((resolve, reject) => {
    const child = spawn(cfg.bin, ["mcp"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
      maxBuffer: 50 * 1024 * 1024,
    });

    const stdoutChunks: Buffer[] = [];
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGTERM");
        reject(new Error(`Ghost OS 超时（${timeoutMs}ms）：${toolName}`));
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("close", () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;

      const elapsed = Date.now() - t0;
      const stdout = Buffer.concat(stdoutChunks).toString();

      if (!stdout.trim()) {
        log(`${toolName}: 无输出 (${elapsed}ms) stderr=${stderr.slice(0, 200)}`);
        reject(new Error(`Ghost OS ${toolName} 无输出`));
        return;
      }

      try {
        // Ghost OS MCP server 可能在 JSON 响应后输出额外文本（如 "Screenshot: 1280x803 - ..."）
        // 提取第一个完整的 JSON 对象（从第一个 { 到对应的 }）
        const firstBrace = stdout.indexOf("{");
        const lastBrace = stdout.lastIndexOf("}");
        if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
          reject(new Error(`Ghost OS ${toolName}: 无 JSON 输出`));
          return;
        }
        const jsonStr = stdout.slice(firstBrace, lastBrace + 1);
        const response = JSON.parse(jsonStr) as {
          result?: { content?: Array<{ type: string; text?: string; data?: string }>; isError?: boolean };
          error?: { message?: string };
        };

        if (response.error) {
          reject(new Error(`Ghost OS ${toolName} 错误: ${response.error.message}`));
          return;
        }

        if (response.result?.isError) {
          const errText = response.result.content?.[0]?.text ?? "未知错误";
          reject(new Error(`Ghost OS ${toolName} 失败: ${errText}`));
          return;
        }

        const textContent = response.result?.content?.find((c) => c.type === "text");
        const imageContent = response.result?.content?.find((c) => c.type === "image");

        if (textContent?.text) {
          const parsed = JSON.parse(textContent.text);
          if (imageContent?.data) {
            parsed._screenshot = {
              data: imageContent.data,
              mimeType: "image/png",
            };
          }
          log(`${toolName}: OK (${elapsed}ms)`);
          resolve(parsed as T);
          return;
        }

        if (imageContent?.data) {
          log(`${toolName}: screenshot OK (${elapsed}ms)`);
          resolve({ _screenshot: { data: imageContent.data, mimeType: "image/png" }, success: true } as T);
          return;
        }

        reject(new Error(`Ghost OS ${toolName}: 无法解析响应`));
      } catch (err) {
        log(`${toolName}: 解析失败 (${elapsed}ms) stdout=${stdout.slice(0, 200)}`);
        reject(new Error(`Ghost OS ${toolName} 响应解析失败: ${err}`));
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(new Error(`Ghost OS 进程错误: ${err.message}`));
      }
    });

    child.stdin.write(request + "\n");
    child.stdin.end();
  });
}

// ============================================================================
// 类型定义
// ============================================================================

interface GhostReadResult {
  success: boolean;
  data: { content: string; item_count: number };
}

interface GhostFindElement {
  name: string;
  role: string;
  actionable: boolean;
  position: { x: number; y: number };
  size: { width: number; height: number };
}

interface GhostFindResult {
  success: boolean;
  data: { count: number; elements: GhostFindElement[]; total_matches: number };
}

interface GhostClickResult {
  success: boolean;
  data: { method: string; element?: string; x?: number; y?: number };
}

interface GhostContextResult {
  success: boolean;
  data: {
    app: string;
    window: string;
    focused_element?: { name: string; role: string };
    interactive_elements?: Array<{ name: string; role: string }>;
  };
  context: { app: string; window: string };
}

interface GhostScreenshotResult {
  success: boolean;
  _screenshot?: { data: string; mimeType: string };
}

export interface GhostScreenshot {
  base64: string;
  mimeType: string;
}

// ============================================================================
// 公开 API
// ============================================================================

/**
 * 读取小红书 App 的文本内容（AX 树深度遍历）。
 * 返回拼接后的文本，包含标题、作者、时间、互动数据等。
 */
export async function ghostRead(
  cfg: GhostConfig = DEFAULT_GHOST_CONFIG,
  depth?: number,
): Promise<{ content: string; itemCount: number }> {
  const result = await callGhostTool<GhostReadResult>(
    "ghost_read",
    { app: cfg.appName, depth: depth ?? cfg.readDepth },
    cfg,
    20_000,
  );
  return {
    content: result.data.content,
    itemCount: result.data.item_count,
  };
}

/**
 * 查找小红书 App 中的元素。
 * 返回匹配元素的位置、尺寸、角色等信息。
 * 位置为屏幕绝对坐标。
 */
export async function ghostFind(
  query: string,
  cfg: GhostConfig = DEFAULT_GHOST_CONFIG,
  opts?: { role?: string; depth?: number },
): Promise<GhostFindElement[]> {
  const args: Record<string, unknown> = {
    app: cfg.appName,
    query,
    depth: opts?.depth ?? cfg.readDepth,
  };
  if (opts?.role) args.role = opts.role;

  const result = await callGhostTool<GhostFindResult>("ghost_find", args, cfg);
  return result.data.elements;
}

/**
 * 获取小红书 App 的上下文信息（当前窗口、焦点元素、可交互元素）。
 */
export async function ghostContext(
  cfg: GhostConfig = DEFAULT_GHOST_CONFIG,
): Promise<GhostContextResult> {
  return callGhostTool<GhostContextResult>("ghost_context", { app: cfg.appName }, cfg);
}

/**
 * 点击小红书 App 中的元素（通过文本查找）。
 * Ghost OS 先尝试 AX-native 点击，失败后自动降级为 synthetic。
 * 点击前自动激活 App（切换 Space）。
 */
export async function ghostClickQuery(
  query: string,
  cfg: GhostConfig = DEFAULT_GHOST_CONFIG,
): Promise<GhostClickResult> {
  return callGhostTool<GhostClickResult>(
    "ghost_click",
    { query, app: cfg.appName },
    cfg,
  );
}

/**
 * 通过窗口相对坐标点击。
 * 内部自动加上 windowOffset 转换为屏幕绝对坐标。
 */
export async function ghostClickCoords(
  x: number,
  y: number,
  cfg: GhostConfig = DEFAULT_GHOST_CONFIG,
): Promise<GhostClickResult> {
  const absX = cfg.windowOffset.x + x;
  const absY = cfg.windowOffset.y + y;
  log(`clickCoords: window=(${x},${y}) → screen=(${absX},${absY})`);
  return callGhostTool<GhostClickResult>(
    "ghost_click",
    { x: absX, y: absY, app: cfg.appName },
    cfg,
  );
}

/**
 * 在当前焦点位置输入文字。
 * 如果指定 into，会先查找目标输入框。
 */
export async function ghostType(
  text: string,
  cfg: GhostConfig = DEFAULT_GHOST_CONFIG,
  opts?: { into?: string; clear?: boolean },
): Promise<void> {
  const args: Record<string, unknown> = { text, app: cfg.appName };
  if (opts?.into) args.into = opts.into;
  if (opts?.clear) args.clear = true;
  await callGhostTool("ghost_type", args, cfg);
}

/**
 * 按下单个按键。
 */
export async function ghostPress(
  key: string,
  cfg: GhostConfig = DEFAULT_GHOST_CONFIG,
  modifiers?: string[],
): Promise<void> {
  const args: Record<string, unknown> = { key, app: cfg.appName };
  if (modifiers?.length) args.modifiers = modifiers;
  await callGhostTool("ghost_press", args, cfg);
}

/**
 * 按下组合键。
 */
export async function ghostHotkey(
  keys: string[],
  cfg: GhostConfig = DEFAULT_GHOST_CONFIG,
): Promise<void> {
  await callGhostTool("ghost_hotkey", { keys, app: cfg.appName }, cfg);
}

/**
 * 滚动内容。
 */
export async function ghostScroll(
  direction: "up" | "down" | "left" | "right",
  cfg: GhostConfig = DEFAULT_GHOST_CONFIG,
  opts?: { amount?: number; x?: number; y?: number },
): Promise<void> {
  const args: Record<string, unknown> = { direction, app: cfg.appName };
  if (opts?.amount !== undefined) args.amount = opts.amount;
  if (opts?.x !== undefined) args.x = cfg.windowOffset.x + opts.x;
  if (opts?.y !== undefined) args.y = cfg.windowOffset.y + opts.y;
  await callGhostTool("ghost_scroll", args, cfg);
}

/**
 * 截图小红书 App 窗口。
 * 返回 base64 编码的 PNG 数据。
 *
 * 优先使用 Ghost OS 内置截图（CGWindowListCreateImage），
 * 失败时自动降级为 macOS screencapture 命令（与 peekaboo 方案一致）。
 */
export async function ghostScreenshot(
  cfg: GhostConfig = DEFAULT_GHOST_CONFIG,
): Promise<GhostScreenshot> {
  // 尝试 Ghost OS 内置截图
  try {
    const result = await callGhostTool<GhostScreenshotResult>(
      "ghost_screenshot",
      { app: cfg.appName },
      cfg,
    );
    if (result._screenshot) {
      return {
        base64: result._screenshot.data,
        mimeType: result._screenshot.mimeType,
      };
    }
  } catch {
    log("ghost_screenshot 失败，降级为 screencapture");
  }

  // 降级：screencapture 截取的是当前 Space 的屏幕，
  // 需要先切换到小红书 App 的 Space
  activateApp(cfg);
  await sleep(1000);
  return screencaptureFallback(cfg);
}

/**
 * 使用 macOS screencapture 截取小红书窗口区域。
 * 窗口区域由 windowOffset + 固定尺寸 1512×949 确定。
 */
function screencaptureFallback(cfg: GhostConfig): GhostScreenshot {
  const { x, y } = cfg.windowOffset;
  const w = 1512;
  const h = 949;
  const region = `${x},${y},${w},${h}`;
  const tmpPath = join(tmpdir(), `ghost_screenshot_${Date.now()}.png`);

  const result = spawnSync("screencapture", ["-x", "-R", region, tmpPath], {
    timeout: 5000,
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.toString()?.trim() || "(无 stderr)";
    throw new Error(
      `screencapture 失败 (exit=${result.status}): ${stderr}` +
      " — 可能需要在系统设置→隐私与安全性→屏幕录制中授权 Node.js",
    );
  }

  try {
    const data = readFileSync(tmpPath);
    if (data.length === 0) {
      throw new Error("screencapture 输出文件为空");
    }
    return {
      base64: data.toString("base64"),
      mimeType: "image/png",
    };
  } finally {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

/**
 * 将小红书 App 带到前台。
 */
export async function ghostFocus(
  cfg: GhostConfig = DEFAULT_GHOST_CONFIG,
): Promise<void> {
  await callGhostTool("ghost_focus", { app: cfg.appName }, cfg);
}

/**
 * 等待条件满足（避免固定 sleep）。
 */
export async function ghostWait(
  condition: "elementExists" | "elementGone" | "titleContains" | "titleChanged",
  value: string,
  cfg: GhostConfig = DEFAULT_GHOST_CONFIG,
  opts?: { timeout?: number; interval?: number },
): Promise<void> {
  const args: Record<string, unknown> = {
    condition,
    value,
    app: cfg.appName,
  };
  if (opts?.timeout) args.timeout = opts.timeout;
  if (opts?.interval) args.interval = opts.interval;
  const timeoutMs = ((opts?.timeout ?? 10) + 5) * 1000;
  await callGhostTool("ghost_wait", args, cfg, timeoutMs);
}

/**
 * 通用 sleep 辅助函数。
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
