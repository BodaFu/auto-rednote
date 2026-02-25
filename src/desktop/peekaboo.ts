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
}

export const DEFAULT_PEEKABOO_CONFIG: PeekabooConfig = {
  bin: "/opt/homebrew/bin/peekaboo",
  appName: "rednote",
  windowTitle: "小红书",
  processName: "discover",
  windowRegion: { x: 0, y: 33, width: 1512, height: 949 },
};

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

/** 将 App 带到前台（iOS on Mac 需要先激活才能响应点击）*/
export function activateApp(cfg: PeekabooConfig): void {
  spawnSync("/usr/bin/osascript", ["-e", `tell application "${cfg.processName}" to activate`], {
    encoding: "utf-8",
    timeout: 5_000,
  });
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
 * 使用 macOS 原生 screencapture 替代 peekaboo image，原因：
 * peekaboo 3.0.0-beta3 在使用 --window-title 参数时会卡死（SWIFT TASK CONTINUATION MISUSE）。
 *
 * 截取区域基于 cfg.windowRegion（默认 x=0, y=33, w=1512, h=949）。
 * 坐标系：截图像素坐标与 clickCoords 坐标一致（x=0,y=0 为窗口内容左上角）。
 */
export function screenshot(cfg: PeekabooConfig): ScreenshotResult {
  const path = join(tmpdir(), `xhs-desktop-${Date.now()}.png`);
  const region = cfg.windowRegion ?? DEFAULT_PEEKABOO_CONFIG.windowRegion!;

  // -x: 不播放快门音效；-R: 指定区域 x,y,width,height
  const result = spawnSync(
    "/usr/sbin/screencapture",
    ["-x", "-R", `${region.x},${region.y},${region.width},${region.height}`, path],
    { encoding: "utf-8", timeout: 10_000 },
  );

  if (result.error) {
    throw new Error(`screencapture 执行错误: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`screencapture 失败（退出码 ${result.status}）: ${result.stderr ?? ""}`);
  }
  if (!existsSync(path)) {
    throw new Error(`screencapture 未生成文件: ${path}`);
  }

  const data = readFileSync(path);
  const base64 = data.toString("base64");
  return { path, base64, dataUri: `data:image/png;base64,${base64}` };
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
  const output = runPeekaboo(["see", "--app", cfg.appName], cfg, { timeoutMs: 20_000 });

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
  const output = runPeekaboo(["click", "--on", elemId, "--app", cfg.appName], cfg);

  const parsed = JSON.parse(output) as Record<string, unknown>;
  const data = (parsed.data ?? {}) as Record<string, unknown>;
  return {
    success: Boolean(data.success),
    clickLocation: data.clickLocation as { x: number; y: number } | undefined,
    targetApp: data.targetApp as string | undefined,
    clickedElement: data.clickedElement as string | undefined,
  };
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
  // 转换为屏幕绝对坐标
  const absX = region.x + x;
  const absY = region.y + y;

  const output = runPeekaboo(
    ["click", "--app", cfg.appName, "--coords", `${absX},${absY}`],
    cfg,
  );

  const parsed = JSON.parse(output) as Record<string, unknown>;
  const data = (parsed.data ?? {}) as Record<string, unknown>;
  return {
    success: Boolean(data.success),
    clickLocation: data.clickLocation as { x: number; y: number } | undefined,
    targetApp: data.targetApp as string | undefined,
  };
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
  runPeekaboo(["type", text, "--app", cfg.appName], cfg, { json: false });
}

/**
 * 按下单个按键（如 "return", "delete", "escape"）。
 *
 * peekaboo press 语法：peekaboo press <keys> --app <app>
 * keys 是位置参数。
 */
export function pressKey(key: string, cfg: PeekabooConfig): void {
  runPeekaboo(["press", key, "--app", cfg.appName], cfg, { json: false });
}

/**
 * 按下组合键（格式："cmd,a" 或 "cmd,shift,z"）。
 *
 * peekaboo hotkey 语法：peekaboo hotkey --keys <keys> --app <app>
 */
export function hotkey(keys: string, cfg: PeekabooConfig): void {
  runPeekaboo(["hotkey", "--keys", keys, "--app", cfg.appName], cfg, { json: false });
}
