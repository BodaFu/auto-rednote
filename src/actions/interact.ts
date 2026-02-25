/**
 * interact.ts - 互动操作：发表评论、回复评论、点赞、收藏
 */

import {
  navigateWithWarmup,
  navigate,
  getOrCreateXhsTab,
  evaluate,
  waitForInitialState,
  act,
  sleep,
  snapshot,
} from "../browser.js";

const XHS_HOME = "https://www.xiaohongshu.com";

// ============================================================================
// 发表评论
// ============================================================================

export async function postComment(
  feedId: string,
  xsecToken: string,
  content: string,
  profile?: string,
): Promise<{ success: boolean; message: string }> {
  const url = `${XHS_HOME}/explore/${feedId}?xsec_token=${encodeURIComponent(xsecToken)}&xsec_source=pc_feed`;
  const { targetId } = await navigateWithWarmup(url, profile);

  // 等待评论区加载
  let commentAreaReady = false;
  for (let i = 0; i < 15; i++) {
    const found = await evaluate(
      targetId,
      `() => document.querySelector('#noteContainer, .note-container, .note-scroller, .comments-container') ? 1 : 0`,
      profile,
    );
    if (found === 1) {
      commentAreaReady = true;
      break;
    }
    await sleep(1000);
  }
  if (!commentAreaReady) {
    return { success: false, message: "评论区未出现，该帖子可能不支持评论" };
  }
  await sleep(500);

  // 步骤1：点击评论输入框的 span 触发激活（div.input-box div.content-edit span）
  const spanClicked = await evaluate(
    targetId,
    `() => {
      const span = document.querySelector('div.input-box div.content-edit span');
      if (span) { span.click(); return true; }
      return false;
    }`,
    profile,
  );
  if (!spanClicked) {
    return { success: false, message: "未找到评论输入框（div.input-box div.content-edit span）" };
  }
  await sleep(500);

  // 步骤2：在激活后的 p.content-input 里输入内容（div.input-box div.content-edit p.content-input）
  const inputClicked = await evaluate(
    targetId,
    `() => {
      const p = document.querySelector('div.input-box div.content-edit p.content-input');
      if (p) { p.focus(); return true; }
      return false;
    }`,
    profile,
  );

  if (inputClicked) {
    // 直接通过 evaluate 输入（模拟 rod 的 Input 方法）
    const typed = await evaluate(
      targetId,
      `() => {
        const p = document.querySelector('div.input-box div.content-edit p.content-input');
        if (!p) return false;
        p.focus();
        document.execCommand('insertText', false, ${JSON.stringify(content)});
        return true;
      }`,
      profile,
    );
    if (!typed) {
      // 降级：通过 ARIA 快照找输入框
      const inputRef = await findCommentInput(targetId, profile);
      if (!inputRef) return { success: false, message: "未找到评论输入区域" };
      await act({ kind: "type", ref: inputRef, text: content, targetId }, profile);
    }
  } else {
    // 降级：通过 ARIA 快照找输入框
    const inputRef = await findCommentInput(targetId, profile);
    if (!inputRef) return { success: false, message: "未找到评论输入区域" };
    await act({ kind: "type", ref: inputRef, text: content, targetId }, profile);
  }
  await sleep(500);

  // 步骤3：点击提交按钮（div.bottom button.submit）
  const submitted = await evaluate(
    targetId,
    `() => {
      const btn = document.querySelector('div.bottom button.submit');
      if (btn && !btn.disabled) { btn.click(); return true; }
      return false;
    }`,
    profile,
  );
  if (!submitted) {
    // 降级到 ARIA 快照
    const ok = await clickSubmitButton(targetId, profile);
    if (!ok) return { success: false, message: "未找到提交按钮" };
  }

  await sleep(1500);
  return { success: true, message: "评论发表成功" };
}

// ============================================================================
// 回复评论
// ============================================================================

export async function replyComment(
  feedId: string,
  xsecToken: string,
  commentId: string,
  content: string,
  parentCommentId?: string,
  profile?: string,
): Promise<{ success: boolean; message: string }> {
  // replyTargetId 是最终用于点击回复按钮的评论 ID，可能在容错降级时被替换为 parentCommentId
  let replyTargetId = commentId;
  const url = `${XHS_HOME}/explore/${feedId}?xsec_token=${encodeURIComponent(xsecToken)}&xsec_source=pc_feed`;
  const targetId = await getOrCreateXhsTab(profile);

  // 在导航前注入 fetch 拦截器，持续收集评论 API 响应。
  // 拦截器将所有 /api/sns/web/v2/comment/page 响应追加到 window.__commentAPIEntries，
  // 后续 scrollToComment 每轮都会读取最新数据，实现多批次 API 检查。
  await injectCommentAPIInterceptor(targetId, profile);

  await navigate(targetId, url, profile).catch(() => null);
  await sleep(2000);

  // 等待评论区加载（最多 15 秒）
  let commentAreaReady = false;
  for (let i = 0; i < 15; i++) {
    const found = await evaluate(
      targetId,
      `() => document.querySelector('#noteContainer, .note-container, .note-scroller, .comments-container') ? 1 : 0`,
      profile,
    );
    if (found === 1) {
      commentAreaReady = true;
      break;
    }
    await sleep(1000);
  }
  if (!commentAreaReady) {
    return { success: false, message: "评论区不可用（已关闭或笔记不支持评论）" };
  }

  // 查找目标评论元素，4 级容错路径
  // API 数据通过 window.__commentAPIEntries 实时读取（由 injectCommentAPIInterceptor 持续收集）
  let commentFound = false;

  if (parentCommentId) {
    // 路径A：有 parentCommentId，先尝试直接展开父评论下的子评论
    commentFound = await expandAndFindSubComment(targetId, parentCommentId, commentId, profile);

    if (!commentFound) {
      // 容错1：parentCommentId 本身可能是子评论（通知 API 的 target_comment_id 语义是"被回复的评论"，
      // 多轮对话时可能是 Liko 自己的子评论而非顶级评论）。
      // 把 parentCommentId 当子评论 ID，从 API 数据反查其真正的顶级父评论。
      const trueParentId = await findParentFromPageAPIEntries(targetId, parentCommentId, profile);
      if (trueParentId) {
        commentFound = await expandAndFindSubComment(targetId, trueParentId, commentId, profile);
      }
    }

    if (!commentFound) {
      // 容错2：父评论路径全部失败，尝试从 API 数据反查 commentId 的真正父评论
      const inferredParent = await findParentFromPageAPIEntries(targetId, commentId, profile);
      if (inferredParent) {
        commentFound = await expandAndFindSubComment(targetId, inferredParent, commentId, profile);
      }
    }

    if (!commentFound) {
      // 容错3：遍历所有有子评论的顶级评论，逐一展开查找
      const topLevelIds = await getTopLevelIdsFromPageAPIEntries(targetId, profile);
      for (const topId of topLevelIds) {
        commentFound = await expandAndFindSubComment(targetId, topId, commentId, profile);
        if (commentFound) break;
      }
    }

    if (!commentFound) {
      // 容错4：所有子评论路径失败，降级为直接滚动查找 commentId（当作顶级评论处理）
      commentFound = await scrollToComment(targetId, commentId, profile);
    }

    if (!commentFound && parentCommentId) {
      // 容错5：commentId 本身也找不到（已删除），降级为回复 parentCommentId
      // 至少能成功回复对方，而不是直接失败
      const parentFound = await scrollToComment(targetId, parentCommentId, profile);
      if (parentFound) {
        commentFound = true;
        replyTargetId = parentCommentId;
      }
    }
  } else {
    // 路径B：无 parentCommentId，先滚动查找顶级评论
    commentFound = await scrollToComment(targetId, commentId, profile);

    if (!commentFound) {
      // 容错1：可能是子评论但调用方未传 parentCommentId，从 API 数据反查父评论
      const inferredParent = await findParentFromPageAPIEntries(targetId, commentId, profile);
      if (inferredParent) {
        commentFound = await expandAndFindSubComment(targetId, inferredParent, commentId, profile);
      }
    }

    if (!commentFound) {
      // 容错2：遍历所有有子评论的顶级评论逐一展开
      const topLevelIds = await getTopLevelIdsFromPageAPIEntries(targetId, profile);
      for (const topId of topLevelIds) {
        commentFound = await expandAndFindSubComment(targetId, topId, commentId, profile);
        if (commentFound) break;
      }
    }
  }

  if (!commentFound) {
    return { success: false, message: `未找到评论 ${commentId}` };
  }

  // 点击回复按钮（.right .interactions .reply）
  const replyClicked = await clickReplyButton(targetId, replyTargetId, profile);
  if (!replyClicked) {
    return { success: false, message: "未找到回复按钮" };
  }
  await sleep(800);

  // 等待回复输入框出现（点击回复按钮后需要等待输入框渲染）
  let inputReady = false;
  for (let i = 0; i < 5; i++) {
    const has = await evaluate(
      targetId,
      `() => document.querySelector('div.input-box div.content-edit p.content-input') ? 1 : 0`,
      profile,
    ).catch(() => 0);
    if (has === 1) {
      inputReady = true;
      break;
    }
    await sleep(500);
  }

  if (!inputReady) {
    // 降级：通过 ARIA 快照找输入框
    const inputRef = await findCommentInput(targetId, profile);
    if (!inputRef) {
      return {
        success: false,
        message: "未找到回复输入框（div.input-box div.content-edit p.content-input）",
      };
    }
    await act({ kind: "type", ref: inputRef, text: content, targetId }, profile);
  } else {
    // 输入回复内容
    const typed = await evaluate(
      targetId,
      `() => {
        const p = document.querySelector('div.input-box div.content-edit p.content-input');
        if (!p) return false;
        p.focus();
        document.execCommand('insertText', false, ${JSON.stringify(content)});
        return true;
      }`,
      profile,
    ).catch(() => false);

    if (!typed) {
      const inputRef = await findCommentInput(targetId, profile);
      if (!inputRef) {
        return {
          success: false,
          message: "未找到回复输入框（div.input-box div.content-edit p.content-input）",
        };
      }
      await act({ kind: "type", ref: inputRef, text: content, targetId }, profile);
    }
  }
  await sleep(500);

  // 提交（div.bottom button.submit）
  const submitted = await evaluate(
    targetId,
    `() => {
      const btn = document.querySelector('div.bottom button.submit');
      if (btn && !btn.disabled) { btn.click(); return true; }
      return false;
    }`,
    profile,
  ).catch(() => false);

  if (!submitted) {
    const ok = await clickSubmitButton(targetId, profile);
    if (!ok) return { success: false, message: "未找到提交按钮" };
  }

  await sleep(1500);
  return { success: true, message: "回复发表成功" };
}

// ============================================================================
// 点赞 / 取消点赞
// ============================================================================

export async function likeFeed(
  feedId: string,
  xsecToken: string,
  unlike = false,
  profile?: string,
): Promise<{ success: boolean; liked: boolean; message: string }> {
  const url = `${XHS_HOME}/explore/${feedId}?xsec_token=${encodeURIComponent(xsecToken)}&xsec_source=pc_feed`;
  const { targetId } = await navigateWithWarmup(url, profile);

  // 等待帖子详情加载
  await waitForInitialState(targetId, "note.noteDetailMap", 10000, profile);
  await sleep(500);

  // 读取当前点赞状态
  const currentLiked = await getLikeStatus(targetId, feedId, profile);

  // 如果状态已经符合预期，直接返回
  if (currentLiked === true && !unlike) {
    return { success: true, liked: true, message: "已经是点赞状态" };
  }
  if (currentLiked === false && unlike) {
    return { success: true, liked: false, message: "已经是未点赞状态" };
  }

  // 点击点赞按钮
  const clicked = await evaluate(
    targetId,
    `() => {
      const btn = document.querySelector('.interact-container .left .like-lottie, .like-wrapper .like-btn, [class*="like-btn"]');
      if (btn) {
        if (typeof btn.click === 'function') btn.click();
        else btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return true;
      }
      return false;
    }`,
    profile,
  );

  if (!clicked) {
    // 通过 ARIA 快照查找
    const snap = await snapshot(targetId, { format: "aria", profile });
    const likeRef = snap.nodes?.find(
      (n) => n.role === "button" && (n.name.includes("点赞") || n.name.includes("赞")),
    )?.ref;
    if (!likeRef) {
      return { success: false, liked: currentLiked ?? false, message: "未找到点赞按钮" };
    }
    await act({ kind: "click", ref: likeRef, targetId }, profile);
  }

  await sleep(1500);

  // 验证状态变化
  const newLiked = await getLikeStatus(targetId, feedId, profile);
  const expectedLiked = !unlike;
  return {
    success: newLiked === expectedLiked,
    liked: newLiked ?? expectedLiked,
    message: newLiked === expectedLiked ? (unlike ? "取消点赞成功" : "点赞成功") : "操作可能未生效",
  };
}

// ============================================================================
// 收藏 / 取消收藏
// ============================================================================

export async function collectFeed(
  feedId: string,
  xsecToken: string,
  uncollect = false,
  profile?: string,
): Promise<{ success: boolean; collected: boolean; message: string }> {
  const url = `${XHS_HOME}/explore/${feedId}?xsec_token=${encodeURIComponent(xsecToken)}&xsec_source=pc_feed`;
  const { targetId } = await navigateWithWarmup(url, profile);

  await waitForInitialState(targetId, "note.noteDetailMap", 10000, profile);
  await sleep(500);

  const currentCollected = await getCollectStatus(targetId, feedId, profile);

  if (currentCollected === true && !uncollect) {
    return { success: true, collected: true, message: "已经是收藏状态" };
  }
  if (currentCollected === false && uncollect) {
    return { success: true, collected: false, message: "已经是未收藏状态" };
  }

  const clicked = await evaluate(
    targetId,
    `() => {
      const btn = document.querySelector('.interact-container .left .reds-icon.collect-icon, .collect-wrapper .collect-btn, [class*="collect-btn"]');
      if (btn) {
        if (typeof btn.click === 'function') btn.click();
        else btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return true;
      }
      return false;
    }`,
    profile,
  );

  if (!clicked) {
    const snap = await snapshot(targetId, { format: "aria", profile });
    const collectRef = snap.nodes?.find(
      (n) => n.role === "button" && (n.name.includes("收藏") || n.name.includes("bookmark")),
    )?.ref;
    if (!collectRef) {
      return { success: false, collected: currentCollected ?? false, message: "未找到收藏按钮" };
    }
    await act({ kind: "click", ref: collectRef, targetId }, profile);
  }

  await sleep(1500);

  const newCollected = await getCollectStatus(targetId, feedId, profile);
  const expectedCollected = !uncollect;
  return {
    success: newCollected === expectedCollected,
    collected: newCollected ?? expectedCollected,
    message:
      newCollected === expectedCollected
        ? uncollect
          ? "取消收藏成功"
          : "收藏成功"
        : "操作可能未生效",
  };
}

// ============================================================================
// 内部辅助
// ============================================================================

async function findCommentInput(targetId: string, profile?: string): Promise<string | null> {
  const snap = await snapshot(targetId, { format: "aria", profile });
  if (!snap.nodes) return null;

  const inputNode = snap.nodes.find(
    (n) =>
      n.role === "textbox" &&
      (n.name.includes("评论") || n.name.includes("说点什么") || n.name.includes("回复")),
  );
  return inputNode?.ref ?? null;
}

async function clickSubmitButton(targetId: string, profile?: string): Promise<boolean> {
  const clicked = await evaluate(
    targetId,
    `() => {
      const btn = document.querySelector('div.bottom button.submit, .comment-submit-btn, [class*="submit-btn"]');
      if (btn && !btn.disabled) { btn.click(); return true; }
      return false;
    }`,
    profile,
  );
  if (clicked === true) return true;

  // ARIA 快照降级
  const snap = await snapshot(targetId, { format: "aria", profile });
  const submitRef = snap.nodes?.find(
    (n) => n.role === "button" && (n.name === "发布" || n.name === "提交" || n.name === "发送"),
  )?.ref;
  if (!submitRef) return false;

  await act({ kind: "click", ref: submitRef, targetId }, profile);
  return true;
}

// ============================================================================
// 评论 API 拦截器（持续收集多批响应）
// ============================================================================

// 在页面注入 fetch/XHR 拦截器，将所有 /api/sns/web/v2/comment/page 响应
// 追加到 window.__commentAPIEntries（{body, hasMore}[]）。
// 必须在导航前调用，确保页面加载时的 API 请求也被捕获。
async function injectCommentAPIInterceptor(targetId: string, profile?: string): Promise<void> {
  await evaluate(
    targetId,
    `() => {
      if (window.__commentAPIInterceptorInstalled) return;
      window.__commentAPIInterceptorInstalled = true;
      window.__commentAPIEntries = [];

      const origFetch = window.fetch;
      window.fetch = async function(...args) {
        const response = await origFetch.apply(this, args);
        const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url ?? '');
        if (url.includes('/api/sns/web/v2/comment/page')) {
          const clone = response.clone();
          clone.text().then(body => {
            try {
              const parsed = JSON.parse(body);
              if (parsed.success && parsed.data?.comments) {
                window.__commentAPIEntries.push({ body, hasMore: !!parsed.data.has_more });
              }
            } catch {}
          }).catch(() => {});
        }
        return response;
      };

      const origXHROpen = XMLHttpRequest.prototype.open;
      const origXHRSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this.__xhrUrl = url;
        return origXHROpen.call(this, method, url, ...rest);
      };
      XMLHttpRequest.prototype.send = function(...args) {
        if (this.__xhrUrl && this.__xhrUrl.includes('/api/sns/web/v2/comment/page')) {
          this.addEventListener('load', () => {
            try {
              const parsed = JSON.parse(this.responseText);
              if (parsed.success && parsed.data?.comments) {
                window.__commentAPIEntries.push({ body: this.responseText, hasMore: !!parsed.data.has_more });
              }
            } catch {}
          });
        }
        return origXHRSend.apply(this, args);
      };
    }`,
    profile,
  );
}

// 从页面的 window.__commentAPIEntries 中读取当前所有已收集的 API 条目
async function readPageAPIEntries(
  targetId: string,
  profile?: string,
): Promise<Array<{ body: string; hasMore: boolean }>> {
  const result = await evaluate(
    targetId,
    `() => JSON.stringify(window.__commentAPIEntries ?? [])`,
    profile,
  );
  try {
    return JSON.parse(result as string) as Array<{ body: string; hasMore: boolean }>;
  } catch {
    return [];
  }
}

// 从页面 API 条目中反查 commentId 所属的顶级父评论 ID
// 对齐 mcp 的 findParentCommentIDWithScroll：数据不足时触发滚动加载更多再重试
async function findParentFromPageAPIEntries(
  targetId: string,
  commentId: string,
  profile?: string,
): Promise<string | null> {
  const maxScrollRounds = 10;

  for (let round = 0; round <= maxScrollRounds; round++) {
    const entries = await readPageAPIEntries(targetId, profile);

    // 在已有数据中查找
    for (const entry of entries) {
      try {
        const resp = JSON.parse(entry.body) as {
          data?: { comments?: Array<{ id: string; sub_comments?: Array<{ id: string }> }> };
        };
        for (const c of resp.data?.comments ?? []) {
          if (c.sub_comments?.some((s) => s.id === commentId)) return c.id;
        }
      } catch {}
    }

    // 如果 API 已无更多数据，不再滚动
    if (entries.length > 0 && !entries[entries.length - 1].hasMore) {
      return null;
    }

    if (round === maxScrollRounds) break;

    // 触发滚动加载更多评论
    const lastCount = entries.length;
    await evaluate(
      targetId,
      `() => { window.scrollBy(0, window.innerHeight * 0.8); }`,
      profile,
    );

    // 等待新数据（最多 5 秒）
    for (let i = 0; i < 5; i++) {
      await sleep(1000);
      const newEntries = await readPageAPIEntries(targetId, profile);
      if (newEntries.length > lastCount) break;
    }
  }

  return null;
}

// 从页面 API 条目中获取所有有子评论的顶级评论 ID 列表
async function getTopLevelIdsFromPageAPIEntries(
  targetId: string,
  profile?: string,
): Promise<string[]> {
  const entries = await readPageAPIEntries(targetId, profile);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of entries) {
    try {
      const resp = JSON.parse(entry.body) as {
        data?: {
          comments?: Array<{
            id: string;
            sub_comment_count?: string;
            sub_comments?: Array<{ id: string }>;
          }>;
        };
      };
      for (const c of resp.data?.comments ?? []) {
        const count = parseInt(c.sub_comment_count ?? "0", 10);
        if ((count > 0 || (c.sub_comments?.length ?? 0) > 0) && !seen.has(c.id)) {
          seen.add(c.id);
          result.push(c.id);
        }
      }
    } catch {}
  }
  return result;
}

// 检查 commentId 在已收集的 API 条目中的状态
// 三态结果：found / not_found / maybe
// 关键：sub_comments 只预加载前几条，当有顶级评论的子评论未完全预加载时
// 不能断定目标已删除，需展开后才能确认（对齐 mcp 的 checkCommentIDInAPIEntries）
function checkCommentInEntries(
  entries: Array<{ body: string; hasMore: boolean }>,
  commentId: string,
): "found" | "not_found" | "maybe" {
  if (entries.length === 0) return "maybe";
  let hasPotentialParent = false;
  for (const entry of entries) {
    try {
      const resp = JSON.parse(entry.body) as {
        success?: boolean;
        data?: {
          comments?: Array<{
            id: string;
            sub_comment_count?: string;
            sub_comments?: Array<{ id: string }>;
          }>;
        };
      };
      if (!resp.success || !resp.data?.comments) continue;
      for (const c of resp.data.comments) {
        if (c.id === commentId) return "found";
        if (c.sub_comments?.some((s) => s.id === commentId)) return "found";
        const subCount = parseInt(c.sub_comment_count ?? "0", 10);
        const preloadedCount = c.sub_comments?.length ?? 0;
        // 仅当子评论未被预加载（preloadedCount === 0）时才标记为 potential，
        // 避免已有预加载数据但目标不在其中时误判为 maybe
        if (subCount > 0 && preloadedCount === 0) {
          hasPotentialParent = true;
        } else if (preloadedCount > 0 && subCount > preloadedCount) {
          // 预加载不完整（有更多子评论未加载）
          hasPotentialParent = true;
        }
      }
    } catch {}
  }
  if (hasPotentialParent) return "maybe";
  const lastEntry = entries[entries.length - 1];
  if (!lastEntry.hasMore) return "not_found";
  return "maybe";
}

// ============================================================================
// 滚动查找顶级评论
// ============================================================================

// 终止条件（按优先级）：
//   1. DOM 中找到目标评论（内容非空）→ 返回 true
//   2. API 确认 has_more=false 且无未展开子评论 → 评论不存在，返回 false
//   3. 检测到 .end-container → 已加载全部评论
//   4. 评论数停滞 3 次 → 已加载完毕
//   5. 超过 maxScrollRounds 轮 → 安全上限
async function scrollToComment(
  targetId: string,
  commentId: string,
  profile?: string,
): Promise<boolean> {
  const maxScrollRounds = 200;

  // 先滚动到评论区
  await evaluate(
    targetId,
    `() => {
      const area = document.querySelector('.comments-container, #noteContainer, .note-scroller');
      if (area) area.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }`,
    profile,
  );
  await sleep(800);

  // 预检：直接查找
  const directFound = await evaluate(
    targetId,
    `() => {
      const el = document.getElementById('comment-${commentId}');
      if (!el) return false;
      el.scrollIntoView({ behavior: 'instant', block: 'center' });
      return el.textContent?.trim() ? true : false;
    }`,
    profile,
  );
  if (directFound === true) return true;

  // 预检 API 数据
  const initialEntries = await readPageAPIEntries(targetId, profile);
  if (
    initialEntries.length > 0 &&
    checkCommentInEntries(initialEntries, commentId) === "not_found"
  ) {
    return false;
  }

  let lastAPICount = initialEntries.length;
  // 用 API 批次数量来判断停滞（而非 DOM 评论数），避免虚拟化导致的误判
  let stagnantAPIChecks = 0;
  // 评论区为空时的快速退出计数
  let emptyAreaChecks = 0;

  for (let round = 0; round < maxScrollRounds; round++) {
    // 1. DOM 查找（scrollIntoView 触发虚拟化渲染）
    const found = await evaluate(
      targetId,
      `() => {
        const el = document.getElementById('comment-${commentId}');
        if (!el) return false;
        el.scrollIntoView({ behavior: 'instant', block: 'center' });
        return el.textContent?.trim() ? true : false;
      }`,
      profile,
    );
    if (found === true) return true;

    // 2. 检查新增的 API 数据
    const currentEntries = await readPageAPIEntries(targetId, profile);
    if (currentEntries.length > lastAPICount) {
      lastAPICount = currentEntries.length;
      stagnantAPIChecks = 0;
      if (checkCommentInEntries(currentEntries, commentId) === "not_found") return false;
    } else {
      stagnantAPIChecks++;
    }

    // 3. 检查是否到达底部
    const isEnd = await evaluate(
      targetId,
      `() => !!document.querySelector('.end-container, [class*="the-end"]')`,
      profile,
    );
    if (isEnd === true) break;

    // 4. 停滞检测：API 数据连续 10 轮无新增才认为加载完毕（每轮 800ms，共 8 秒）
    // 不再依赖 DOM 评论数，因为虚拟化会导致 DOM 数量不稳定
    const currentDOMCount = (await evaluate(
      targetId,
      `() => document.querySelectorAll('.parent-comment').length`,
      profile,
    )) as number;

    if (currentDOMCount === 0 && lastAPICount === 0) {
      emptyAreaChecks++;
      // 评论区完全空且 API 无数据，说明评论区未加载或已关闭
      if (emptyAreaChecks >= 3) break;
    } else {
      emptyAreaChecks = 0;
    }

    if (stagnantAPIChecks >= 10) break;

    // 5. 滚动到最后一个评论触发懒加载
    await evaluate(
      targetId,
      `() => {
        const comments = document.querySelectorAll('.parent-comment');
        if (comments.length > 0) {
          comments[comments.length - 1].scrollIntoView({ behavior: 'smooth', block: 'end' });
        } else {
          window.scrollBy(0, window.innerHeight * 0.8);
        }
      }`,
      profile,
    );
    await sleep(800);
  }

  return false;
}

// ============================================================================
// 展开父评论子评论列表，查找目标子评论
// ============================================================================

// 先用 scrollToComment 定位父评论，展开"查看回复"，再循环展开"更多回复"查找目标子评论。
async function expandAndFindSubComment(
  targetId: string,
  parentCommentId: string,
  commentId: string,
  profile?: string,
): Promise<boolean> {
  // 1. 用 scrollToComment 找到父评论（父评论是顶级评论，走顶级评论查找路径）
  const parentFound = await scrollToComment(targetId, parentCommentId, profile);
  if (!parentFound) return false;

  // 2. 展开子评论（点击 .show-more "展开 N 条回复"）
  const expandResult = await evaluate(
    targetId,
    `() => {
      const parentEl = document.getElementById('comment-${parentCommentId}');
      if (!parentEl) return 'parent-not-found';
      const parentComment = parentEl.parentElement; // .parent-comment
      if (!parentComment) return 'parent-comment-not-found';
      const showMore = parentComment.querySelector('.show-more');
      if (!showMore) return 'no-show-more';
      showMore.scrollIntoView({ behavior: 'smooth', block: 'center' });
      showMore.click();
      return showMore.textContent?.trim() || 'clicked';
    }`,
    profile,
  );

  if (
    expandResult !== "parent-not-found" &&
    expandResult !== "parent-comment-not-found" &&
    expandResult !== "no-show-more"
  ) {
    await sleep(2000);
  }

  // 3. 循环查找目标子评论，每轮点击"展开更多回复"（最多 30 轮）
  const maxExpandRounds = 30;

  const checkSubComment = async (): Promise<boolean> => {
    const found = await evaluate(
      targetId,
      `() => {
        const el = document.getElementById('comment-${commentId}');
        if (!el) return false;
        el.scrollIntoView({ behavior: 'instant', block: 'center' });
        return el.textContent?.trim() ? true : false;
      }`,
      profile,
    );
    return found === true;
  };

  for (let i = 0; i < maxExpandRounds; i++) {
    if (await checkSubComment()) return true;

    const moreText = await evaluate(
      targetId,
      `() => {
        const parentEl = document.getElementById('comment-${parentCommentId}');
        if (!parentEl) return 'parent-lost';
        const parentComment = parentEl.parentElement;
        if (!parentComment) return 'no-parent-comment';
        const showMore = parentComment.querySelector('.show-more');
        if (!showMore) return 'no-more';
        showMore.scrollIntoView({ block: 'center' });
        showMore.click();
        return showMore.textContent?.trim() || 'clicked';
      }`,
      profile,
    );
    if (moreText === "no-more" || moreText === "parent-lost" || moreText === "no-parent-comment") {
      break;
    }
    await sleep(1500);
  }

  return await checkSubComment();
}

async function clickReplyButton(
  targetId: string,
  commentId: string,
  profile?: string,
): Promise<boolean> {
  const clicked = await evaluate(
    targetId,
    `() => {
      // #comment-{id} 是 .comment-item，回复按钮在其内部的 .right .interactions .reply
      const comment = document.getElementById('comment-${commentId}') || document.querySelector('[data-id="${commentId}"]');
      if (!comment) return 'not-found';
      // 先在 comment 元素内找
      let replyBtn = comment.querySelector('.right .interactions .reply');
      // 若没有，向上找 .parent-comment 再找（兼容不同 DOM 层级）
      if (!replyBtn) {
        const parentComment = comment.closest('.parent-comment') || comment.parentElement;
        if (parentComment) replyBtn = parentComment.querySelector('.right .interactions .reply, .reply-btn');
      }
      if (replyBtn) {
        replyBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
        replyBtn.click();
        return 'clicked';
      }
      return 'no-btn';
    }`,
    profile,
  );
  return clicked === "clicked";
}

async function getLikeStatus(
  targetId: string,
  feedId: string,
  profile?: string,
): Promise<boolean | null> {
  const result = await evaluate(
    targetId,
    `() => {
      try {
        const state = window.__INITIAL_STATE__;
        if (!state?.note?.noteDetailMap) return null;
        const note = state.note.noteDetailMap['${feedId}'];
        if (!note) return null;
        const n = note.note || note;
        return n?.interactInfo?.liked ?? null;
      } catch { return null; }
    }`,
    profile,
  );
  return typeof result === "boolean" ? result : null;
}

async function getCollectStatus(
  targetId: string,
  feedId: string,
  profile?: string,
): Promise<boolean | null> {
  const result = await evaluate(
    targetId,
    `() => {
      try {
        const state = window.__INITIAL_STATE__;
        if (!state?.note?.noteDetailMap) return null;
        const note = state.note.noteDetailMap['${feedId}'];
        if (!note) return null;
        const n = note.note || note;
        return n?.interactInfo?.collected ?? null;
      } catch { return null; }
    }`,
    profile,
  );
  return typeof result === "boolean" ? result : null;
}
