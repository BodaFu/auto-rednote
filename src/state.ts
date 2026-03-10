/**
 * state.ts - 通知状态持久化（Node.js 内置 node:sqlite）
 *
 * 管理小红书通知的处理状态，支持：
 * - pending: 待处理
 * - replied: 已回复
 * - skipped: 已跳过
 * - retry: 待重试
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { NotificationRecord, NotificationStatus, XhsNotification } from "./types.js";

const DEFAULT_DB_PATH = path.join(os.homedir(), ".openclaw", "auto-rednote.db");

let _db: DatabaseSync | null = null;

function getDb(dbPath?: string): DatabaseSync {
  if (_db) return _db;

  const resolvedPath = dbPath ?? DEFAULT_DB_PATH;
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  _db = new DatabaseSync(resolvedPath);
  initSchema(_db);
  return _db;
}

function initSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'pending',
      notification TEXT NOT NULL,
      reply_content TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status);
    CREATE INDEX IF NOT EXISTS idx_notifications_updated_at ON notifications(updated_at);

    CREATE TABLE IF NOT EXISTS commented_feeds (
      feed_id TEXT NOT NULL,
      comment_content TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (feed_id, comment_content)
    );
    CREATE INDEX IF NOT EXISTS idx_commented_feeds_feed_id ON commented_feeds(feed_id);
  `);
}

// ============================================================================
// 公开 API
// ============================================================================

export function initState(dbPath?: string): void {
  getDb(dbPath);
}

/**
 * 批量插入通知（忽略已存在的）
 */
export function upsertNotifications(notifications: XhsNotification[], dbPath?: string): void {
  const db = getDb(dbPath);
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO notifications (id, status, notification, created_at, updated_at)
    VALUES (?, 'pending', ?, ?, ?)
  `);
  for (const n of notifications) {
    stmt.run(n.id, JSON.stringify(n), now, now);
  }
}

/**
 * 获取待处理通知列表
 */
export function getPendingNotifications(limit = 50, dbPath?: string): NotificationRecord[] {
  const db = getDb(dbPath);
  const rows = db
    .prepare(`
    SELECT id, status, notification, reply_content, created_at, updated_at
    FROM notifications
    WHERE status IN ('pending', 'retry')
    ORDER BY created_at ASC
    LIMIT ?
  `)
    .all(limit) as Array<{
    id: string;
    status: string;
    notification: string;
    reply_content: string | null;
    created_at: number;
    updated_at: number;
  }>;

  return rows.map((r) => ({
    id: r.id,
    status: r.status as NotificationStatus,
    notification: r.notification,
    replyContent: r.reply_content ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

/**
 * 更新通知状态
 */
export function updateNotificationStatus(
  id: string,
  status: NotificationStatus,
  replyContent?: string,
  dbPath?: string,
): void {
  const db = getDb(dbPath);
  const now = Date.now();
  db.prepare(`
    UPDATE notifications
    SET status = ?, reply_content = ?, updated_at = ?
    WHERE id = ?
  `).run(status, replyContent ?? null, now, id);
}

/**
 * 获取通知统计
 */
export function getNotificationStats(dbPath?: string): Record<NotificationStatus, number> {
  const db = getDb(dbPath);
  const rows = db
    .prepare(`
    SELECT status, COUNT(*) as count
    FROM notifications
    GROUP BY status
  `)
    .all() as Array<{ status: string; count: number }>;

  const stats: Record<NotificationStatus, number> = {
    pending: 0,
    replied: 0,
    skipped: 0,
    retry: 0,
  };
  for (const row of rows) {
    if (row.status in stats) {
      stats[row.status as NotificationStatus] = row.count;
    }
  }
  return stats;
}

/**
 * 检查通知是否已存在
 */
export function notificationExists(id: string, dbPath?: string): boolean {
  const db = getDb(dbPath);
  const row = db.prepare("SELECT 1 FROM notifications WHERE id = ?").get(id);
  return row != null;
}

/**
 * 获取最近处理的通知时间（用于增量拉取）
 */
export function getLatestNotificationTime(dbPath?: string): number | null {
  const db = getDb(dbPath);
  const row = db
    .prepare(`
    SELECT MAX(created_at) as latest FROM notifications
  `)
    .get() as { latest: number | null };
  return row?.latest ?? null;
}

// ============================================================================
// 评论去重 API
// ============================================================================

/**
 * 检查是否已经对某篇笔记发表过评论
 */
export function hasCommentedOnFeed(feedId: string, dbPath?: string): boolean {
  const db = getDb(dbPath);
  const row = db.prepare("SELECT 1 FROM commented_feeds WHERE feed_id = ? LIMIT 1").get(feedId);
  return row != null;
}

/**
 * 记录对某篇笔记的评论
 */
export function recordFeedComment(feedId: string, content: string, dbPath?: string): void {
  const db = getDb(dbPath);
  const now = Date.now();
  db.prepare(`
    INSERT OR IGNORE INTO commented_feeds (feed_id, comment_content, created_at)
    VALUES (?, ?, ?)
  `).run(feedId, content.substring(0, 200), now);
}

/**
 * 获取对某篇笔记的历史评论数
 */
export function getFeedCommentCount(feedId: string, dbPath?: string): number {
  const db = getDb(dbPath);
  const row = db
    .prepare("SELECT COUNT(*) as count FROM commented_feeds WHERE feed_id = ?")
    .get(feedId) as { count: number } | undefined;
  return row?.count ?? 0;
}

/**
 * 关闭数据库连接
 */
export function closeState(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
