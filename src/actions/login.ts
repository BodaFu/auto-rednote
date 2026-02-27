/**
 * login.ts - 登录状态检查与二维码获取
 *
 * 检查策略：访问 /explore 页面，检查用户导航元素是否存在
 */

import { navigateWithWarmup, evaluate, waitForLoad, sleep, act, snapshot } from "../browser.js";

const XHS_EXPLORE = "https://www.xiaohongshu.com/explore";
const XHS_HOME = "https://www.xiaohongshu.com";

// ============================================================================
// 检查登录状态
// ============================================================================

export async function checkLoginStatus(profile?: string): Promise<{
  loggedIn: boolean;
  message: string;
}> {
  const { targetId } = await navigateWithWarmup(XHS_EXPLORE, profile);
  await sleep(1500);

  // 优先使用 __INITIAL_STATE__.user.loggedIn（最可靠，不受 DOM 变化影响）
  const stateCheck = await evaluate(
    targetId,
    `() => {
      try {
        const state = window.__INITIAL_STATE__;
        if (!state?.user) return null;
        if (state.user.loggedIn === true) return true;
        if (state.user.loggedIn === false) return false;
        const userInfo = state.user.userInfo;
        const u = userInfo?._value ?? userInfo?.value ?? userInfo;
        return !!(u?.userId || u?.user_id);
      } catch { return null; }
    }`,
    profile,
  );

  if (stateCheck === true) {
    return { loggedIn: true, message: "已登录" };
  }
  if (stateCheck === false) {
    return { loggedIn: false, message: "未登录" };
  }

  // __INITIAL_STATE__ 不可用时，降级到 DOM 检测
  const hasLoginBtn = await evaluate(
    targetId,
    `() => !!document.querySelector('.login-btn, .login-container')`,
    profile,
  );
  if (hasLoginBtn === true) {
    return { loggedIn: false, message: "未登录，检测到登录按钮" };
  }

  // 最后降级：ARIA 快照
  const snap = await snapshot(targetId, { format: "aria", profile });
  const hasUserProfile = snap.nodes?.some(
    (n) => n.role === "link" && (n.name.includes("个人主页") || n.name.includes("我的主页")),
  );

  return {
    loggedIn: hasUserProfile === true,
    message: hasUserProfile ? "已登录" : "未登录",
  };
}

// ============================================================================
// 获取登录二维码
// ============================================================================

export async function getLoginQrcode(profile?: string): Promise<{
  qrcodeUrl: string | null;
  alreadyLoggedIn: boolean;
  message: string;
}> {
  const { targetId } = await navigateWithWarmup(XHS_HOME, profile);
  await sleep(1000);

  // 检查是否已登录
  const loginCheck = await checkLoginStatus(profile);
  if (loginCheck.loggedIn) {
    return {
      qrcodeUrl: null,
      alreadyLoggedIn: true,
      message: "已登录，无需扫码",
    };
  }

  // 触发登录弹窗（如果还没有的话）
  const hasLoginContainer = await evaluate(
    targetId,
    `() => !!document.querySelector('.login-container')`,
    profile,
  );

  if (!hasLoginContainer) {
    // 点击登录按钮触发弹窗
    const loginBtnRef = await findLoginButton(targetId, profile);
    if (loginBtnRef) {
      await act({ kind: "click", ref: loginBtnRef, targetId }, profile);
      await sleep(1500);
    }
  }

  // 等待二维码出现
  try {
    await act(
      {
        kind: "wait",
        selector: ".login-container .qrcode-img, .qrcode-container img",
        targetId,
        timeoutMs: 8000,
      },
      profile,
    );
  } catch {
    // 二维码可能还没出现
  }

  // 提取二维码 src
  const qrcodeSrc = await evaluate(
    targetId,
    `() => {
      const img = document.querySelector('.login-container .qrcode-img, .qrcode-container img, [class*="qrcode"] img');
      return img ? img.src : null;
    }`,
    profile,
  );

  if (typeof qrcodeSrc === "string" && qrcodeSrc) {
    return {
      qrcodeUrl: qrcodeSrc,
      alreadyLoggedIn: false,
      message: "请使用小红书 App 扫描二维码登录",
    };
  }

  return {
    qrcodeUrl: null,
    alreadyLoggedIn: false,
    message: "未能获取二维码，请手动打开小红书网页登录",
  };
}

// ============================================================================
// 内部辅助
// ============================================================================

async function findLoginButton(targetId: string, profile?: string): Promise<string | null> {
  const snap = await snapshot(targetId, { format: "aria", profile });
  if (!snap.nodes) return null;

  const loginNode = snap.nodes.find(
    (n) =>
      (n.role === "button" || n.role === "link") &&
      (n.name.includes("登录") ||
        n.name.includes("注册") ||
        n.name.toLowerCase().includes("sign in")),
  );
  return loginNode?.ref ?? null;
}
