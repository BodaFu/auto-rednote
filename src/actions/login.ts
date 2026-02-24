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

  // 检查用户导航元素（已登录时存在）
  const loggedInFn = `() => {
    // 已登录：存在用户头像/昵称链接
    const userLink = document.querySelector('.main-container .user .link-wrapper .channel, .user-info .avatar, .user-wrapper .avatar-wrapper');
    if (userLink) return true;
    // 已登录：存在发布按钮
    const publishBtn = document.querySelector('.upload-entry, [data-v-type="upload"]');
    if (publishBtn) return true;
    // 未登录：存在登录按钮
    const loginBtn = document.querySelector('.login-btn, .sign-in, [class*="login"]');
    return false;
  }`;

  const loggedIn = await evaluate(targetId, loggedInFn, profile);

  if (loggedIn === true) {
    return { loggedIn: true, message: "已登录" };
  }

  // 二次确认：检查是否有登录弹窗
  const hasLoginModal = await evaluate(
    targetId,
    `() => !!document.querySelector('.login-container, .login-popup, [class*="login-modal"]')`,
    profile,
  );

  if (hasLoginModal === true) {
    return { loggedIn: false, message: "未登录，检测到登录弹窗" };
  }

  // 通过 ARIA 快照检查
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
