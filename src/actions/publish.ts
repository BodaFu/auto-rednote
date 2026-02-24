/**
 * publish.ts - 发布笔记（图文 / 视频统一入口）
 *
 * 注意：发布功能在 creator.xiaohongshu.com 域名下，
 * 需要确保 Chrome 已登录小红书（host profile 共享 cookie）
 */

import {
  navigateWithWarmup,
  evaluate,
  waitForSelector,
  waitForLoad,
  act,
  sleep,
  snapshot,
  openTab,
  navigate,
  armFileChooser,
  closeTab,
} from "../browser.js";

const CREATOR_PUBLISH_URL = "https://creator.xiaohongshu.com/publish/publish?source=official";

// ============================================================================
// 发布参数
// ============================================================================

export interface PublishNoteParams {
  type: "image" | "video";
  title: string;
  content: string;
  mediaPaths: string[];
  tags?: string[];
  scheduleAt?: string;
}

export interface PublishResult {
  success: boolean;
  message: string;
  noteId?: string;
}

// ============================================================================
// 发布笔记（统一入口）
// ============================================================================

export async function publishNote(
  params: PublishNoteParams,
  profile?: string,
): Promise<PublishResult> {
  if (params.type === "image") {
    return publishImageNote(params, profile);
  }
  return publishVideoNote(params, profile);
}

// ============================================================================
// 发布图文
// ============================================================================

async function publishImageNote(
  params: PublishNoteParams,
  profile?: string,
): Promise<PublishResult> {
  // creator 域名需要单独打开（不走 xiaohongshu.com 的 SPA 预热）
  const tab = await openTab(CREATOR_PUBLISH_URL, profile);
  const targetId = tab.targetId;

  try {
    await waitForLoad(targetId, 30000, profile);
    await sleep(2000);

    // 点击"上传图文" TAB
    const tabClicked = await clickPublishTab(targetId, "上传图文", profile);
    if (!tabClicked) {
      // 可能已经在图文 tab，继续
    }
    await sleep(1000);

    // 上传图片
    if (params.mediaPaths.length === 0) {
      return { success: false, message: "至少需要提供一张图片" };
    }

    const uploadResult = await uploadImages(targetId, params.mediaPaths, profile);
    if (!uploadResult) {
      return { success: false, message: "图片上传失败" };
    }

    // 输入标题
    await inputTitle(targetId, params.title, profile);
    await sleep(300);

    // 输入正文
    await inputContent(targetId, params.content, profile);
    await sleep(300);

    // 输入标签
    if (params.tags && params.tags.length > 0) {
      await inputTags(targetId, params.tags, profile);
    }

    // 定时发布
    if (params.scheduleAt) {
      await setScheduleTime(targetId, params.scheduleAt, profile);
    }

    // 点击发布
    const published = await clickPublishButton(targetId, profile);
    if (!published) {
      return { success: false, message: "未找到发布按钮" };
    }

    await sleep(3000);
    const noteId = await extractPublishedNoteId(targetId, profile);
    return { success: true, message: "图文笔记发布成功", noteId };
  } catch (err) {
    return {
      success: false,
      message: `发布失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    await closeTab(targetId, profile).catch(() => {});
  }
}

// ============================================================================
// 发布视频
// ============================================================================

async function publishVideoNote(
  params: PublishNoteParams,
  profile?: string,
): Promise<PublishResult> {
  const tab = await openTab(CREATOR_PUBLISH_URL, profile);
  const targetId = tab.targetId;

  try {
    await waitForLoad(targetId, 30000, profile);
    await sleep(2000);

    // 点击"上传视频" TAB
    await clickPublishTab(targetId, "上传视频", profile);
    await sleep(1000);

    // 上传视频文件
    if (params.mediaPaths.length === 0) {
      return { success: false, message: "需要提供视频文件路径" };
    }

    const videoUploaded = await uploadVideo(targetId, params.mediaPaths[0]!, profile);
    if (!videoUploaded) {
      return { success: false, message: "视频上传失败" };
    }

    // 等待视频处理
    await sleep(3000);

    // 输入标题
    await inputTitle(targetId, params.title, profile);
    await sleep(300);

    // 输入正文
    await inputContent(targetId, params.content, profile);
    await sleep(300);

    // 输入标签
    if (params.tags && params.tags.length > 0) {
      await inputTags(targetId, params.tags, profile);
    }

    // 定时发布
    if (params.scheduleAt) {
      await setScheduleTime(targetId, params.scheduleAt, profile);
    }

    // 点击发布
    const published = await clickPublishButton(targetId, profile);
    if (!published) {
      return { success: false, message: "未找到发布按钮" };
    }

    await sleep(3000);
    const noteId = await extractPublishedNoteId(targetId, profile);
    return { success: true, message: "视频笔记发布成功", noteId };
  } catch (err) {
    return {
      success: false,
      message: `发布失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    await closeTab(targetId, profile).catch(() => {});
  }
}

// ============================================================================
// 内部辅助
// ============================================================================

async function clickPublishTab(
  targetId: string,
  tabText: string,
  profile?: string,
): Promise<boolean> {
  const clicked = await evaluate(
    targetId,
    `() => {
      const tabs = document.querySelectorAll('div.creator-tab, .publish-tab, [class*="tab-item"]');
      for (const tab of tabs) {
        if (tab.textContent?.includes('${tabText}')) {
          tab.click();
          return true;
        }
      }
      return false;
    }`,
    profile,
  );
  return clicked === true;
}

async function uploadImages(
  targetId: string,
  imagePaths: string[],
  profile?: string,
): Promise<boolean> {
  // 通过 browser 的 file chooser 上传
  // 先找上传输入框
  const uploadRef = await findUploadInput(targetId, profile);
  if (!uploadRef) return false;

  try {
    await armFileChooser(targetId, imagePaths, uploadRef, profile);

    // 等待上传完成（检查预览图数量）
    const expectedCount = imagePaths.length;
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      const count = await evaluate(
        targetId,
        `() => document.querySelectorAll('.img-preview-area .pr, .upload-preview-item, [class*="preview-item"]').length`,
        profile,
      );
      if (typeof count === "number" && count >= expectedCount) return true;
    }
    // 超时后检查是否至少有一张预览图
    const finalCount = await evaluate(
      targetId,
      `() => document.querySelectorAll('.img-preview-area .pr, .upload-preview-item, [class*="preview-item"]').length`,
      profile,
    );
    return typeof finalCount === "number" && finalCount > 0;
  } catch {
    return false;
  }
}

async function uploadVideo(
  targetId: string,
  videoPath: string,
  profile?: string,
): Promise<boolean> {
  const uploadRef = await findUploadInput(targetId, profile);
  if (!uploadRef) return false;

  try {
    await armFileChooser(targetId, [videoPath], uploadRef, profile);
    return true;
  } catch {
    return false;
  }
}

async function findUploadInput(targetId: string, profile?: string): Promise<string | null> {
  const snap = await snapshot(targetId, { format: "aria", profile });
  if (!snap.nodes) return null;

  const uploadNode = snap.nodes.find(
    (n) =>
      n.role === "button" &&
      (n.name.includes("上传") || n.name.includes("upload") || n.name.includes("添加")),
  );
  if (uploadNode) return uploadNode.ref;

  // 降级：直接查找 file input
  const fileInputRef = await evaluate(
    targetId,
    `() => {
      const input = document.querySelector('.upload-input, input[type="file"]');
      return input ? 'file-input' : null;
    }`,
    profile,
  );
  return typeof fileInputRef === "string" ? fileInputRef : null;
}

async function inputTitle(targetId: string, title: string, profile?: string): Promise<void> {
  const snap = await snapshot(targetId, { format: "aria", profile });
  const titleRef = snap.nodes?.find(
    (n) => n.role === "textbox" && (n.name.includes("标题") || n.name.includes("title")),
  )?.ref;

  if (titleRef) {
    await act({ kind: "click", ref: titleRef, targetId }, profile);
    await act({ kind: "type", ref: titleRef, text: title, targetId }, profile);
    return;
  }

  // 降级：直接操作 DOM
  await evaluate(
    targetId,
    `() => {
      const input = document.querySelector('div.d-input input, .title-input input, [placeholder*="标题"]');
      if (input) {
        input.focus();
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }`,
    profile,
  );
  await sleep(200);
  const inputRef = snap.nodes?.find((n) => n.role === "textbox")?.ref;
  if (inputRef) {
    await act({ kind: "type", ref: inputRef, text: title, targetId }, profile);
  }
}

async function inputContent(targetId: string, content: string, profile?: string): Promise<void> {
  const snap = await snapshot(targetId, { format: "aria", profile });
  const contentRef = snap.nodes?.find(
    (n) =>
      n.role === "textbox" &&
      (n.name.includes("正文") || n.name.includes("内容") || n.name.includes("描述")),
  )?.ref;

  if (contentRef) {
    await act({ kind: "click", ref: contentRef, targetId }, profile);
    await act({ kind: "type", ref: contentRef, text: content, targetId }, profile);
    return;
  }

  // 降级：操作 ql-editor，重新获取快照避免引用过期
  await evaluate(
    targetId,
    `() => {
      const editor = document.querySelector('div.ql-editor, [data-placeholder*="输入正文"], [contenteditable="true"]');
      if (editor) { editor.focus(); editor.click(); }
    }`,
    profile,
  );
  await sleep(200);
  const snap2 = await snapshot(targetId, { format: "aria", profile });
  const editorRef = snap2.nodes?.find(
    (n) => n.role === "textbox" && !n.name.includes("标题") && !n.name.includes("title"),
  )?.ref;
  if (editorRef) {
    await act({ kind: "type", ref: editorRef, text: content, targetId }, profile);
  }
}

async function inputTags(targetId: string, tags: string[], profile?: string): Promise<void> {
  for (const tag of tags) {
    // 将光标移到内容末尾，输入 # + 标签名
    await act({ kind: "press", key: "End", targetId }, profile);
    await sleep(200);

    await evaluate(
      targetId,
      `() => {
        const editor = document.querySelector('div.ql-editor, [contenteditable="true"]');
        if (!editor) return;
        editor.focus();
        // 移到末尾
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }`,
      profile,
    );

    // 输入 # 触发标签联想
    const snap = await snapshot(targetId, { format: "aria", profile });
    const editorRef = snap.nodes?.find((n) => n.role === "textbox")?.ref;

    if (editorRef) {
      await act({ kind: "type", ref: editorRef, text: `#${tag}`, targetId }, profile);
      await sleep(800);

      // 等待标签联想出现并点击第一个
      try {
        await waitForSelector(
          targetId,
          "#creator-editor-topic-container .item, .topic-item, [class*='topic-item']",
          3000,
          profile,
        );
        await evaluate(
          targetId,
          `() => {
            const item = document.querySelector('#creator-editor-topic-container .item, .topic-item, [class*="topic-item"]');
            if (item) item.click();
          }`,
          profile,
        );
        await sleep(300);
      } catch {
        // 没有联想结果，按 Enter 确认
        await act({ kind: "press", key: "Enter", targetId }, profile);
        await sleep(200);
      }
    }
  }
}

async function setScheduleTime(
  targetId: string,
  scheduleAt: string,
  profile?: string,
): Promise<void> {
  // 点击定时发布开关
  const switchClicked = await evaluate(
    targetId,
    `() => {
      const sw = document.querySelector('.post-time-wrapper .d-switch, [class*="schedule"] [class*="switch"]');
      if (sw) { sw.click(); return true; }
      return false;
    }`,
    profile,
  );

  if (!switchClicked) return;
  await sleep(500);

  // 输入时间（格式：YYYY-MM-DD HH:mm）
  await evaluate(
    targetId,
    `() => {
      const input = document.querySelector('.date-picker-container input, [class*="date-picker"] input, [class*="schedule"] input');
      if (!input) return;
      input.focus();
      input.value = '${scheduleAt}';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }`,
    profile,
  );
  await sleep(300);
}

async function clickPublishButton(targetId: string, profile?: string): Promise<boolean> {
  const clicked = await evaluate(
    targetId,
    `() => {
      const btn = document.querySelector('.publish-page-publish-btn button.bg-red, .publish-btn, [class*="publish-btn"]');
      if (btn && !btn.disabled) { btn.click(); return true; }
      return false;
    }`,
    profile,
  );
  if (clicked === true) return true;

  // ARIA 快照降级
  const snap = await snapshot(targetId, { format: "aria", profile });
  const publishRef = snap.nodes?.find(
    (n) => n.role === "button" && (n.name === "发布" || n.name === "立即发布"),
  )?.ref;
  if (!publishRef) return false;

  await act({ kind: "click", ref: publishRef, targetId }, profile);
  return true;
}

async function extractPublishedNoteId(
  targetId: string,
  profile?: string,
): Promise<string | undefined> {
  try {
    // 等待跳转到成功页或笔记详情页
    await sleep(2000);
    const url = await evaluate(targetId, `() => window.location.href`, profile);
    if (typeof url === "string") {
      // 匹配 /explore/{noteId} 或 /discovery/item/{noteId}
      const m = url.match(/\/(?:explore|discovery\/item)\/([a-f0-9]{24})/i);
      if (m) return m[1];
    }
    // 降级：从成功提示中提取
    const text = await evaluate(targetId, `() => document.body.innerText`, profile);
    if (typeof text === "string") {
      const m = text.match(/([a-f0-9]{24})/);
      if (m) return m[1];
    }
  } catch {
    // 提取失败不影响发布结果
  }
  return undefined;
}
