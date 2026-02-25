/**
 * publish.ts - 发布笔记（图文 / 视频统一入口）
 *
 * 所有 DOM 交互通过 evaluate（原生 JS）执行，
 * 不依赖 Playwright aria-ref 选择器（CDP 连接下不可用）。
 */

import { copyFile, mkdir, unlink } from "node:fs/promises";
import { basename, join } from "node:path";

import {
  navigateWithWarmup,
  evaluate,
  waitForLoad,
  act,
  sleep,
  armFileChooser,
  isTabLostError,
} from "../browser.js";

const CREATOR_PUBLISH_URL = "https://creator.xiaohongshu.com/publish/publish?source=official";
const UPLOAD_DIR = "/tmp/openclaw/uploads";

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

const MAX_PUBLISH_ATTEMPTS = 3;

async function stageMediaFiles(paths: string[]): Promise<{ staged: string[]; cleanup: () => Promise<void> }> {
  await mkdir(UPLOAD_DIR, { recursive: true });
  const staged: string[] = [];
  for (const src of paths) {
    const dest = join(UPLOAD_DIR, `${Date.now()}-${basename(src)}`);
    await copyFile(src, dest);
    staged.push(dest);
  }
  return {
    staged,
    cleanup: async () => {
      await Promise.allSettled(staged.map((f) => unlink(f)));
    },
  };
}

export async function publishNote(
  params: PublishNoteParams,
  profile?: string,
): Promise<PublishResult> {
  const { staged, cleanup } = await stageMediaFiles(params.mediaPaths);
  const stagedParams = { ...params, mediaPaths: staged };

  try {
    let lastResult: PublishResult = { success: false, message: "未执行" };

    for (let attempt = 1; attempt <= MAX_PUBLISH_ATTEMPTS; attempt++) {
      lastResult =
        stagedParams.type === "image"
          ? await publishImageNote(stagedParams, profile)
          : await publishVideoNote(stagedParams, profile);

      if (lastResult.success || !isTabLostError(lastResult.message)) {
        return lastResult;
      }

      if (attempt < MAX_PUBLISH_ATTEMPTS) {
        await sleep(2000 * attempt);
      }
    }

    return lastResult;
  } finally {
    await cleanup();
  }
}

// ============================================================================
// 发布图文
// ============================================================================

async function publishImageNote(
  params: PublishNoteParams,
  profile?: string,
): Promise<PublishResult> {
  try {
    const { targetId } = await navigateWithWarmup(CREATOR_PUBLISH_URL, profile);

    await waitForLoad(targetId, 30000, profile);
    await sleep(2000);

    await clickPublishTab(targetId, "上传图文", profile);
    await sleep(1000);

    if (params.mediaPaths.length === 0) {
      return { success: false, message: "至少需要提供一张图片" };
    }

    await uploadImages(targetId, params.mediaPaths, profile);

    await inputTitle(targetId, params.title, profile);
    await sleep(300);

    await inputContent(targetId, params.content, profile);
    await sleep(300);

    if (params.tags && params.tags.length > 0) {
      await inputTags(targetId, params.tags, profile);
    }

    if (params.scheduleAt) {
      await setScheduleTime(targetId, params.scheduleAt, profile);
    }

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
  }
}

// ============================================================================
// 发布视频
// ============================================================================

async function publishVideoNote(
  params: PublishNoteParams,
  profile?: string,
): Promise<PublishResult> {
  try {
    const { targetId } = await navigateWithWarmup(CREATOR_PUBLISH_URL, profile);

    await waitForLoad(targetId, 30000, profile);
    await sleep(2000);

    await clickPublishTab(targetId, "上传视频", profile);
    await sleep(1000);

    if (params.mediaPaths.length === 0) {
      return { success: false, message: "需要提供视频文件路径" };
    }

    await uploadVideo(targetId, params.mediaPaths[0]!, profile);

    await sleep(3000);

    await inputTitle(targetId, params.title, profile);
    await sleep(300);

    await inputContent(targetId, params.content, profile);
    await sleep(300);

    if (params.tags && params.tags.length > 0) {
      await inputTags(targetId, params.tags, profile);
    }

    if (params.scheduleAt) {
      await setScheduleTime(targetId, params.scheduleAt, profile);
    }

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
  }
}

// ============================================================================
// 内部辅助：全部使用 evaluate (原生 JS DOM 操作)
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
): Promise<void> {
  for (let i = 0; i < imagePaths.length; i++) {
    const selector = i === 0 ? ".upload-input" : 'input[type="file"]';

    await armFileChooser(targetId, [imagePaths[i]!], {
      element: selector,
      profile,
    });

    await waitForImagePreview(targetId, i + 1, profile);
    await sleep(1000);
  }
}

async function waitForImagePreview(
  targetId: string,
  expectedCount: number,
  profile?: string,
): Promise<void> {
  const maxWait = 60;
  for (let s = 0; s < maxWait; s++) {
    await sleep(1000);
    const count = await evaluate(
      targetId,
      `() => document.querySelectorAll('.img-preview-area .pr, .upload-preview-item, [class*="preview-item"]').length`,
      profile,
    );
    if (typeof count === "number" && count >= expectedCount) return;
  }
  throw new Error(`图片上传超时: 等待第 ${expectedCount} 张预览图超过 ${maxWait}s`);
}

async function uploadVideo(
  targetId: string,
  videoPath: string,
  profile?: string,
): Promise<void> {
  await armFileChooser(targetId, [videoPath], {
    element: '.upload-input, input[type="file"]',
    profile,
  });
}

async function inputTitle(targetId: string, title: string, profile?: string): Promise<void> {
  const escapedTitle = JSON.stringify(title);
  const filled = await evaluate(
    targetId,
    `() => {
      const input = document.querySelector('input[placeholder*="标题"], .title-input input, div.d-input input');
      if (!input) return false;
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (nativeSetter) {
        nativeSetter.call(input, ${escapedTitle});
      } else {
        input.value = ${escapedTitle};
      }
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }`,
    profile,
  );
  if (!filled) throw new Error("未找到标题输入框");
}

async function inputContent(targetId: string, content: string, profile?: string): Promise<void> {
  const escapedContent = JSON.stringify(content);
  const filled = await evaluate(
    targetId,
    `() => {
      const editor = document.querySelector('div.ql-editor, [data-placeholder*="输入正文"], [contenteditable="true"]');
      if (!editor) return false;
      editor.focus();
      editor.innerHTML = ${escapedContent}.split('\\n').map(line => '<p>' + (line || '<br>') + '</p>').join('');
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }`,
    profile,
  );
  if (!filled) throw new Error("未找到内容编辑器");
}

async function inputTags(targetId: string, tags: string[], profile?: string): Promise<void> {
  for (const tag of tags) {
    const escapedTag = JSON.stringify(`#${tag}`);

    // 在编辑器末尾插入标签文本（通过 DOM 模拟 InputEvent）
    await evaluate(
      targetId,
      `() => {
        const editor = document.querySelector('div.ql-editor, [contenteditable="true"]');
        if (!editor) return false;
        editor.focus();
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        document.execCommand('insertText', false, ${escapedTag});
        return true;
      }`,
      profile,
    );

    await sleep(800);

    // 等待标签联想并点击
    const tagClicked = await evaluate(
      targetId,
      `() => new Promise(resolve => {
        let tries = 0;
        const check = () => {
          const item = document.querySelector('#creator-editor-topic-container .item, .topic-item, [class*="topic-item"]');
          if (item) { item.click(); resolve(true); return; }
          if (++tries < 10) setTimeout(check, 300);
          else resolve(false);
        };
        check();
      })`,
      profile,
    );

    if (!tagClicked) {
      await act({ kind: "press", key: "Enter", targetId }, profile);
    }
    await sleep(300);
  }
}

async function setScheduleTime(
  targetId: string,
  scheduleAt: string,
  profile?: string,
): Promise<void> {
  const escapedTime = JSON.stringify(scheduleAt);
  await evaluate(
    targetId,
    `() => {
      const sw = document.querySelector('.post-time-wrapper .d-switch, [class*="schedule"] [class*="switch"]');
      if (sw) sw.click();
    }`,
    profile,
  );
  await sleep(500);

  await evaluate(
    targetId,
    `() => {
      const input = document.querySelector('.date-picker-container input, [class*="date-picker"] input, [class*="schedule"] input');
      if (!input) return;
      input.focus();
      input.value = ${escapedTime};
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
      // 优先精确匹配发布按钮
      const selectors = [
        'button.css-k01jl8',
        '.publishBtn button',
        'button.el-button--primary',
        '.publish-page-publish-btn button.bg-red',
        '.publish-btn',
        '[class*="publish-btn"]',
      ];
      for (const sel of selectors) {
        const btn = document.querySelector(sel);
        if (btn && !btn.disabled) { btn.click(); return true; }
      }
      // 模糊匹配
      const btns = document.querySelectorAll('button');
      for (const btn of btns) {
        const text = btn.textContent?.trim();
        if ((text === '发布' || text === '立即发布') && !btn.disabled) {
          btn.click();
          return true;
        }
      }
      return false;
    }`,
    profile,
  );
  return clicked === true;
}

async function extractPublishedNoteId(
  targetId: string,
  profile?: string,
): Promise<string | undefined> {
  try {
    await sleep(2000);
    const url = await evaluate(targetId, `() => window.location.href`, profile);
    if (typeof url === "string") {
      const m = url.match(/\/(?:explore|discovery\/item)\/([a-f0-9]{24})/i);
      if (m) return m[1];
    }
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
