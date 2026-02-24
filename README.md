# auto-rednote

**OpenClaw extension for Xiaohongshu (小红书 / RedNote) automation.**

Reuses your already-logged-in Chrome via OpenClaw's browser control, giving an AI agent full access to Xiaohongshu web operations — no separate browser process, no API keys, no reverse-engineering.

[中文文档 →](./README.zh-CN.md)

---

## How it works

```
AI Agent (Claude / Gemini / …)
  → xhs_* tool calls
  → auto-rednote extension (TypeScript)
  → HTTP → OpenClaw browser control server (127.0.0.1:18791)
  → Playwright → your logged-in Chrome
  → Xiaohongshu web (www.xiaohongshu.com)
```

The extension never spawns its own browser. It controls the Chrome instance that OpenClaw already manages, sharing your login session automatically.

---

## Prerequisites

| Requirement | Details |
|---|---|
| [OpenClaw](https://github.com/openclaw/openclaw) | Installed and gateway running |
| Chrome | Logged in to Xiaohongshu web (`https://www.xiaohongshu.com`) |
| OpenClaw browser | Started via `openclaw browser start` |
| Node.js | ≥ 22 (for built-in `node:sqlite`) |

---

## Installation

### 1. Clone into OpenClaw's extensions directory

```bash
cd /path/to/openclaw/extensions
git clone https://github.com/BodaFu/auto-rednote.git
```

### 2. Install dependencies

```bash
cd auto-rednote
npm install
```

### 3. Enable in OpenClaw config

Add to your OpenClaw configuration file (usually `~/.openclaw/config.json`):

```json
{
  "plugins": {
    "entries": {
      "auto-rednote": {
        "enabled": true,
        "config": {
          "dbPath": "~/.openclaw/auto-rednote.db"
        }
      }
    }
  }
}
```

### 4. Restart the OpenClaw gateway

```bash
kill -HUP $(pgrep -f openclaw-gateway)
```

---

## Configuration

| Key | Type | Default | Description |
|---|---|---|---|
| `dbPath` | string | `~/.openclaw/auto-rednote.db` | SQLite database path for notification state |
| `browserProfile` | string | *(host Chrome)* | OpenClaw browser profile name |

---

## Tools (19 total)

### Account

| Tool | Description |
|---|---|
| `xhs_check_login` | Check Xiaohongshu login status |
| `xhs_get_qrcode` | Get login QR code URL (when not logged in) |
| `xhs_my_profile` | Get your own profile info |
| `xhs_my_notes` | Get your notes list with engagement stats |

### Content

| Tool | Description |
|---|---|
| `xhs_list_feeds` | Get recommended feed list |
| `xhs_search` | Search notes by keyword, sort, type, time range |
| `xhs_get_feed` | Get note detail with comments |
| `xhs_get_user` | Get a user's profile and notes |

### Interaction

| Tool | Description |
|---|---|
| `xhs_post_comment` | Post a top-level comment on a note |
| `xhs_reply_comment` | Reply to a comment (supports multi-level threads) |
| `xhs_like` | Like / unlike a note |
| `xhs_collect` | Collect / uncollect a note |
| `xhs_follow` | Follow / unfollow a user |

### Notifications

| Tool | Description |
|---|---|
| `xhs_get_notifications` | Fetch raw notifications (comments, replies, @mentions) |
| `xhs_get_notifications_pending` | Get unprocessed notifications (for agent heartbeat loops) |
| `xhs_mark_notification` | Mark a notification as replied / skipped / retry |
| `xhs_notification_stats` | Get notification processing statistics |

### Publishing

| Tool | Description |
|---|---|
| `xhs_publish` | Publish an image or video note |

---

## Example agent workflows

### Auto-reply to new comments

```
User: Check for new Xiaohongshu comments and reply "Thanks for your support!"

Agent flow:
1. xhs_check_login           → confirm logged in
2. xhs_get_notifications { maxPages: 2 }
3. filter comment_on_my_note / reply_to_my_comment types
4. xhs_reply_comment { feedId, xsecToken, commentId, content: "Thanks for your support!" }
5. xhs_mark_notification { id, status: "replied" }
```

### Search and like

```
User: Search "mobile photography tips", like the top 3

Agent flow:
1. xhs_search { keyword: "mobile photography tips", sortBy: "most_liked" }
2. take first 3 results
3. xhs_like { feedId, xsecToken } × 3
```

---

## Technical notes

- **SPA warm-up**: Xiaohongshu is a React SPA. The extension ensures Chrome has visited the homepage to initialize `window.__INITIAL_STATE__` before extracting data.
- **Data extraction**: Prioritizes structured data from `window.__INITIAL_STATE__`; falls back to DOM parsing.
- **API interception**: Notification fetching intercepts `/api/sns/web/v1/you/mentions` via OpenClaw's response body endpoint. Comment reply uses a continuous `fetch`/XHR interceptor injected into the page (`window.__commentAPIEntries`) to handle virtualized rendering and multi-level threads.
- **Multi-level comment handling**: `xhs_reply_comment` implements a 4-level fallback strategy to locate comments in virtualized lists, including inferring true parent IDs from intercepted API data.
- **Notification state**: Uses Node.js built-in `node:sqlite` to persist notification processing state in a local SQLite database.

---

## License

MIT — see [LICENSE](./LICENSE).

This project is not affiliated with or endorsed by Xiaohongshu (小红书).
