/**
 * peekaboo.ts - peekaboo CLI 封装层
 *
 * 通过调用 /opt/homebrew/bin/peekaboo（或配置的路径）实现
 * 对小红书桌面 App（iOS on macOS）的截图、UI 元素扫描和交互操作。
 *
 * 注意：小红书 macOS App 是 iOS 移植版（arm64），不是 Electron，
 * 因此无法使用 CDP 协议，只能通过 macOS Accessibility API + 视觉方式操作。
 *
 * 坐标系说明：
 * - 小红书窗口从屏幕 y=33 开始（顶部菜单栏高度），尺寸 1512×949
 * - clickCoords 使用窗口相对坐标（x=0,y=0 为窗口内容左上角）
 * - screenshot 截取的是窗口内容区域，像素坐标与 clickCoords 一致
 *
 * 已知问题（peekaboo 3.0.0-beta3）：
 * - `peekaboo image --window-title 小红书` 会卡死（SWIFT TASK CONTINUATION MISUSE）
 * - `peekaboo see --window-title 小红书` 同样卡死
 * - 解决方案：截图改用 macOS 原生 screencapture；see 去掉 --window-title
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TAG = "[desktop-im]";
function log(...args: unknown[]): void {
  console.error(TAG, ...args);
}

// ============================================================================
// 配置
// ============================================================================

export interface PeekabooConfig {
  /** peekaboo 二进制路径，默认 /opt/homebrew/bin/peekaboo */
  bin: string;
  /** App 名称（peekaboo list apps 中显示的名称），默认 rednote */
  appName: string;
  /** 窗口标题，默认 小红书（仅用于文档，截图/see 不使用此参数以避免卡死）*/
  windowTitle: string;
  /** 内部进程名（用于 osascript activate），默认 discover */
  processName: string;
  /**
   * 小红书窗口在屏幕上的区域（用于 screencapture）。
   * 格式：{ x, y, width, height }，单位为逻辑像素（非 Retina）。
   * 默认：{ x: 0, y: 33, width: 1512, height: 949 }（全屏 1512×982，顶部菜单栏 33px）
   */
  windowRegion?: { x: number; y: number; width: number; height: number };
  /**
   * 操作完成后是否自动切回原来的前台 App。
   *
   * - true（默认）：适合在个人电脑上使用，Liko 操作完小红书后立刻切回用户正在用的 App，
   *   桌面只会短暂闪烁约 1-2 秒。
   * - false：适合专用设备部署（无人值守服务器/专用 Mac），操作完保持在小红书界面。
   *
   * 对应 openclaw.json 插件配置：`"desktopRestoreApp": false`
   */
  restoreApp: boolean;
}

export const DEFAULT_PEEKABOO_CONFIG: PeekabooConfig = {
  bin: "/opt/homebrew/bin/peekaboo",
  appName: "rednote",
  windowTitle: "小红书",
  processName: "discover",
  windowRegion: { x: 0, y: 33, width: 1512, height: 949 },
  restoreApp: false,
};

/**
 * Space 切换动画等待时间（ms）。
 *
 * 实测：activateApp 命令本身约 130-200ms，Space 动画约 100-150ms，
 * 合计约 250ms 后截图内容已完整。设为 350ms 保留 100ms 余量。
 *
 * 若截图出现黑屏或截到错误 App，可适当增大此值。
 * 在"系统设置 → 辅助功能 → 显示 → 减少动态效果"开启后可降低到 200ms。
 */
export const SPACE_SWITCH_WAIT_MS = 350;

// ============================================================================
// 类型定义
// ============================================================================

export interface PeekabooElement {
  id: string;
  role: string;
  role_description?: string;
  label?: string;
  description?: string;
  value?: string;
  is_actionable?: boolean;
}

export interface ScreenshotResult {
  /** 截图文件路径（临时目录） */
  path: string;
  /** base64 编码的 PNG 数据 */
  base64: string;
  /** Data URI（data:image/png;base64,...）*/
  dataUri: string;
}

export interface SeeResult {
  snapshotId: string;
  elements: PeekabooElement[];
  elementCount: number;
  interactableCount: number;
}

export interface ClickResult {
  success: boolean;
  clickLocation?: { x: number; y: number };
  targetApp?: string;
  clickedElement?: string;
}

// ============================================================================
// 内部：运行 peekaboo CLI
// ============================================================================

function runPeekaboo(
  args: string[],
  cfg: PeekabooConfig,
  opts: { json?: boolean; timeoutMs?: number } = {},
): string {
  if (!existsSync(cfg.bin)) {
    throw new Error(
      `peekaboo 未安装或路径不存在: ${cfg.bin}。` +
        `请运行: brew install peekaboo（或在插件配置中指定 peekabooPath）`,
    );
  }

  const finalArgs = opts.json !== false ? [...args, "--json"] : args;

  const result = spawnSync(cfg.bin, finalArgs, {
    encoding: "utf-8",
    timeout: opts.timeoutMs ?? 15_000,
    env: { ...process.env },
  });

  if (result.error) {
    const msg = result.error.message;
    if (msg.includes("ETIMEDOUT") || msg.includes("timeout")) {
      throw new Error(`peekaboo 超时（${opts.timeoutMs ?? 15000}ms）：${args[0]} 命令未响应`);
    }
    throw new Error(`peekaboo 执行错误: ${msg}`);
  }

  // 非零退出码时尝试从输出提取错误信息
  if (result.status !== 0) {
    const errOutput = (result.stdout ?? "") + (result.stderr ?? "");
    let errMsg = `peekaboo 退出码 ${result.status}`;
    try {
      const parsed = JSON.parse(result.stdout ?? "");
      if (parsed?.error?.message) errMsg = parsed.error.message;
      else if (parsed?.error) errMsg = JSON.stringify(parsed.error);
    } catch {
      if (errOutput.trim()) errMsg += `: ${errOutput.slice(0, 200)}`;
    }
    throw new Error(errMsg);
  }

  return result.stdout ?? "";
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 获取当前前台 App 的名称（用于操作完成后切回）。
 *
 * 使用 `path to frontmost application`（约 80ms），比
 * `System Events get name of first process whose frontmost is true`（约 400ms）快 5 倍。
 * 返回 App bundle 名（如 "Cursor"、"Feishu"、"Lark"），不含 .app 后缀。
 * 如果无法获取，返回 null（此时 restoreApp 的切回操作将跳过）。
 */
export function getFrontmostApp(): string | null {
  const t0 = Date.now();
  const result = spawnSync(
    "/usr/bin/osascript",
    ["-e", "path to frontmost application as text"],
    { encoding: "utf-8", timeout: 2_000 },
  );
  if (result.status !== 0 || !result.stdout?.trim()) {
    log("getFrontmostApp: failed", result.status, result.stderr?.trim());
    return null;
  }
  const raw = result.stdout.trim();
  const match = raw.match(/:([^:]+)\.app:?$/);
  const name = match ? match[1] : raw;
  log(`getFrontmostApp: "${name}" (${Date.now() - t0}ms)`);
  return name;
}

/**
 * 将指定 App 切回前台（操作完成后恢复用户环境）。
 * 用 `tell application X to activate`（非全屏 App 不需要 System Events）。
 */
export function restoreFrontmostApp(appName: string): void {
  log(`restoreFrontmostApp: switching back to "${appName}"`);
  spawnSync(
    "/usr/bin/osascript",
    ["-e", `tell application "${appName}" to activate`],
    { encoding: "utf-8", timeout: 3_000 },
  );
}

/**
 * 将 App 带到前台并切换到其所在 Space。
 *
 * 使用 System Events 的 `set frontmost to true`，
 * 这是唯一能跨 Space 切换到全屏 App 的方式。
 * `tell application X to activate` 只激活进程，不切换 Space。
 *
 * 注意：切换 Space 需要约 600ms 动画时间，调用后需等待。
 */
export function activateApp(cfg: PeekabooConfig): void {
  const t0 = Date.now();
  const result = spawnSync(
    "/usr/bin/osascript",
    [
      "-e",
      `tell application "System Events" to tell application process "${cfg.processName}" to set frontmost to true`,
    ],
    { encoding: "utf-8", timeout: 5_000 },
  );
  log(
    `activateApp: process="${cfg.processName}" status=${result.status} (${Date.now() - t0}ms)`,
    result.stderr?.trim() ? `stderr=${result.stderr.trim()}` : "",
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// 截图
// ============================================================================

/**
 * 截图小红书主窗口，返回文件路径 + base64。
 *
 * 前置条件：调用方必须已通过 activateApp + sleep(SPACE_SWITCH_WAIT_MS) 切换到小红书 Space，
 * 否则 screencapture 会截到当前 Space 的其他 App。
 *
 * 截取区域基于 cfg.windowRegion（默认 x=0, y=33, w=1512, h=949）。
 * 坐标系：截图像素坐标与 clickCoords 坐标一致（x=0,y=0 为窗口内容左上角）。
 */
export function screenshot(cfg: PeekabooConfig): ScreenshotResult {
  const t0 = Date.now();
  const path = join(tmpdir(), `xhs-desktop-${Date.now()}.png`);
  const region = cfg.windowRegion ?? DEFAULT_PEEKABOO_CONFIG.windowRegion!;
  const regionStr = `${region.x},${region.y},${region.width},${region.height}`;

  const captureResult = spawnSync(
    "/usr/sbin/screencapture",
    ["-x", "-R", regionStr, path],
    { encoding: "utf-8", timeout: 10_000 },
  );

  if (captureResult.error) {
    log(`screenshot: ERROR ${captureResult.error.message}`);
    throw new Error(`screencapture 执行错误: ${captureResult.error.message}`);
  }
  if (captureResult.status !== 0) {
    log(`screenshot: FAILED exit=${captureResult.status} stderr=${captureResult.stderr}`);
    throw new Error(`screencapture 失败（退出码 ${captureResult.status}）: ${captureResult.stderr ?? ""}`);
  }
  if (!existsSync(path)) {
    log(`screenshot: file not created at ${path}`);
    throw new Error(`screencapture 未生成文件: ${path}`);
  }

  // Retina 屏幕截图为 2x 分辨率（3024×1898），需缩放到逻辑像素（1512×949）
  // 使截图像素坐标与 clickCoords 坐标系一致
  // 注意：必须用 -z（精确像素）而不是 --resampleWidth（受 DPI 影响）
  const resizeResult = spawnSync(
    "/usr/bin/sips",
    ["-z", String(region.height), String(region.width), path],
    { encoding: "utf-8", timeout: 10_000 },
  );
  if (resizeResult.status !== 0) {
    log(`screenshot: sips resize failed, using original Retina image. stderr=${resizeResult.stderr}`);
  }

  const data = readFileSync(path);
  const base64 = data.toString("base64");
  log(`screenshot: region=${regionStr} size=${data.length}bytes path=${path} (${Date.now() - t0}ms)`);
  return { path, base64, dataUri: `data:image/png;base64,${base64}` };
}

/**
 * 激活 App 并等待 Space 切换动画完成，然后截图。
 *
 * 等同于 activateApp + sleep(SPACE_SWITCH_WAIT_MS) + screenshot，
 * 用于需要独立截图（不在连续操作序列中）的场景。
 */
export async function activateAndScreenshot(cfg: PeekabooConfig): Promise<ScreenshotResult> {
  activateApp(cfg);
  await sleep(SPACE_SWITCH_WAIT_MS);
  return screenshot(cfg);
}

// ============================================================================
// UI 元素扫描
// ============================================================================

/**
 * 扫描当前窗口的 UI 元素树（基于 macOS Accessibility API）。
 *
 * 注意：不传 --window-title，避免 peekaboo 3.0.0-beta3 的卡死 bug。
 * iOS App 的 AX 树质量较低，大多数元素 label 为"按钮"/"文本"。
 * 有意义的标签（如"2条未读"）可以用于定位和点击。
 */
export function seeElements(cfg: PeekabooConfig): SeeResult {
  // 不传 --window-title，避免 peekaboo 卡死
  // 超时设为 8s（iOS App 的 see 命令可能卡死，调用方应 try/catch 降级）
  const output = runPeekaboo(["see", "--app", cfg.appName], cfg, { timeoutMs: 8_000 });

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error(`解析 peekaboo see 输出失败: ${output.slice(0, 200)}`);
  }

  if (!parsed.success) {
    const msg =
      (parsed.error as { message?: string } | undefined)?.message ??
      JSON.stringify(parsed.error ?? parsed);
    throw new Error(`peekaboo see 失败: ${msg}`);
  }

  const data = (parsed.data ?? {}) as Record<string, unknown>;
  return {
    snapshotId: String(data.snapshot_id ?? ""),
    elements: (data.ui_elements as PeekabooElement[]) ?? [],
    elementCount: Number(data.element_count ?? 0),
    interactableCount: Number(data.interactable_count ?? 0),
  };
}

// ============================================================================
// 点击操作
// ============================================================================

/** 通过 peekaboo 元素 ID 点击（最稳定，ID 来自 seeElements 的快照）*/
export function clickElement(elemId: string, cfg: PeekabooConfig): ClickResult {
  log(`clickElement: elemId="${elemId}"`);
  const t0 = Date.now();
  const output = runPeekaboo(["click", "--on", elemId, "--app", cfg.appName], cfg);

  const parsed = JSON.parse(output) as Record<string, unknown>;
  const data = (parsed.data ?? {}) as Record<string, unknown>;
  const result = {
    success: Boolean(data.success),
    clickLocation: data.clickLocation as { x: number; y: number } | undefined,
    targetApp: data.targetApp as string | undefined,
    clickedElement: data.clickedElement as string | undefined,
  };
  log(`clickElement: result=${result.success ? "OK" : "FAIL"} clickedAt=(${result.clickLocation?.x},${result.clickLocation?.y}) (${Date.now() - t0}ms)`);
  return result;
}

/**
 * 通过窗口相对坐标点击。
 *
 * 坐标系：x=0,y=0 为窗口内容左上角（不含顶部菜单栏）。
 * 与 screenshot() 返回的截图像素坐标一致。
 *
 * peekaboo click --coords 接受的是屏幕绝对坐标，
 * 因此这里会自动加上 windowRegion 的偏移量（默认 y+=33）。
 */
export function clickCoords(x: number, y: number, cfg: PeekabooConfig): ClickResult {
  const region = cfg.windowRegion ?? DEFAULT_PEEKABOO_CONFIG.windowRegion!;
  const absX = region.x + x;
  const absY = region.y + y;

  log(`clickCoords: window=(${x},${y}) → screen=(${absX},${absY}) [offset: x+${region.x}, y+${region.y}]`);

  const t0 = Date.now();
  const output = runPeekaboo(
    ["click", "--app", cfg.appName, "--coords", `${absX},${absY}`],
    cfg,
  );

  const parsed = JSON.parse(output) as Record<string, unknown>;
  const data = (parsed.data ?? {}) as Record<string, unknown>;
  const clickLoc = data.clickLocation as { x: number; y: number } | undefined;
  const targetApp = data.targetApp as string | undefined;
  const success = Boolean(data.success);

  log(
    `clickCoords: result=${success ? "OK" : "FAIL"}`,
    `actualClick=(${clickLoc?.x ?? "?"},${clickLoc?.y ?? "?"})`,
    `targetApp="${targetApp ?? "?"}"`,
    `(${Date.now() - t0}ms)`,
    success ? "" : `raw=${JSON.stringify(data).slice(0, 200)}`,
  );

  return { success, clickLocation: clickLoc, targetApp };
}

// ============================================================================
// 输入操作
// ============================================================================

/**
 * 在当前焦点位置输入文字（支持中文）。
 * 调用前需确保已点击文本输入框获取焦点。
 *
 * peekaboo type 语法：peekaboo type <text> --app <app>
 * text 是位置参数，必须放在子命令后、选项前。
 */
export function typeText(text: string, cfg: PeekabooConfig): void {
  log(`typeText: "${text.slice(0, 50)}${text.length > 50 ? "..." : ""}" (${text.length} chars)`);
  const t0 = Date.now();
  runPeekaboo(["type", text, "--app", cfg.appName], cfg, { json: false });
  log(`typeText: done (${Date.now() - t0}ms)`);
}

/**
 * 按下单个按键（如 "return", "delete", "escape"）。
 *
 * peekaboo press 语法：peekaboo press <keys> --app <app>
 * keys 是位置参数。
 */
export function pressKey(key: string, cfg: PeekabooConfig): void {
  log(`pressKey: "${key}"`);
  runPeekaboo(["press", key, "--app", cfg.appName], cfg, { json: false });
}

/**
 * 按下组合键（格式："cmd,a" 或 "cmd,shift,z"）。
 *
 * peekaboo hotkey 语法：peekaboo hotkey --keys <keys> --app <app>
 */
export function hotkey(keys: string, cfg: PeekabooConfig): void {
  log(`hotkey: "${keys}"`);
  runPeekaboo(["hotkey", "--keys", keys, "--app", cfg.appName], cfg, { json: false });
}
