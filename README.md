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
  → in-process call → OpenClaw browser control
  → Playwright → your logged-in Chrome (OpenClaw profile)
  → Xiaohongshu web (www.xiaohongshu.com)
```

The extension calls OpenClaw's browser control **in-process** — no separate HTTP port needed. It controls the Chromium instance that OpenClaw manages, sharing your login session automatically.

---

## Prerequisites

| Requirement | Details |
|---|---|
| [OpenClaw](https://github.com/openclaw/openclaw) | Installed and gateway running (`openclaw gateway`) |
| OpenClaw browser | Started via `openclaw browser` (uses the built-in `openclaw` Chrome profile) |
| Node.js | ≥ 22 (for built-in `node:sqlite`) |
| Xiaohongshu account | Logged in via the OpenClaw browser (see setup below) |

---

## Installation

### Step 1 — Find your OpenClaw extensions directory

The extensions directory is next to the OpenClaw installation:

```bash
# npm global install (most common)
ls $(npm root -g)/openclaw/extensions/

# Homebrew
ls /opt/homebrew/lib/node_modules/openclaw/extensions/

# Source checkout
ls /path/to/openclaw/extensions/
```

> **Tip**: Run `openclaw doctor` — it prints the gateway binary path. The `extensions/` folder is in the same parent directory.

### Step 2 — Clone auto-rednote into the extensions directory

```bash
cd $(npm root -g)/openclaw/extensions   # adjust path for your install
git clone https://github.com/BodaFu/auto-rednote.git
cd auto-rednote
npm install
```

### Step 3 — Enable in OpenClaw config

Open `~/.openclaw/openclaw.json` (create if missing) and add:

```json
{
  "plugins": {
    "entries": {
      "auto-rednote": {
        "enabled": true
      }
    }
  }
}
```

Optional: set a custom SQLite database path:

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

### Step 4 — Log in to Xiaohongshu in the OpenClaw browser

OpenClaw manages a dedicated Chrome profile (`openclaw`). You need to log in to Xiaohongshu inside this browser:

```bash
openclaw browser
```

This opens the OpenClaw Chromium window. Navigate to `https://www.xiaohongshu.com` and log in normally. The session is persisted in the `openclaw` profile.

### Step 5 — Restart the gateway

```bash
# Send HUP to reload extensions without full restart
kill -HUP $(pgrep -f "openclaw.*gateway")

# Or do a full restart
openclaw gateway --force
```

### Step 6 — Verify

Ask your agent: *"Call xhs_check_login and tell me the result."*

Expected response: `{ "loggedIn": true, "message": "已登录" }`

---

## Configuration

| Key | Type | Default | Description |
|---|---|---|---|
| `dbPath` | string | `~/.openclaw/auto-rednote.db` | SQLite database path for notification state |

> The `browserProfile` option is not needed — the extension always uses OpenClaw's built-in `openclaw` Chrome profile.

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

- **In-process browser control**: The extension imports OpenClaw's internal browser client directly (via `jiti` TypeScript loader). No HTTP port is needed — all browser calls go through OpenClaw's in-process dispatcher.
- **SPA warm-up**: Xiaohongshu is a React SPA. The extension ensures Chrome has visited the homepage to initialize `window.__INITIAL_STATE__` before extracting data.
- **Data extraction**: Prioritizes structured data from `window.__INITIAL_STATE__`; falls back to DOM parsing.
- **API interception**: Notification fetching intercepts `/api/sns/web/v1/you/mentions`. Comment reply injects a continuous `fetch`/XHR interceptor (`window.__commentAPIEntries`) to handle virtualized rendering and multi-level threads.
- **Multi-level comment handling**: `xhs_reply_comment` implements a 4-level fallback strategy to locate comments in virtualized lists, including inferring true parent IDs from intercepted API data.
- **Notification state**: Uses Node.js built-in `node:sqlite` to persist notification processing state in a local SQLite database.

---

## Troubleshooting

**`plugin not found: auto-rednote`**
The extension directory was not found. Check that `auto-rednote/` is directly inside the `extensions/` folder next to your OpenClaw installation, and that `npm install` was run inside it.

**`Can't reach the OpenClaw browser control service`**
The OpenClaw browser hasn't started yet, or the Chromium process crashed. Run `openclaw browser` to open the browser window, wait a few seconds, then retry.

**`{ "loggedIn": false }`**
You need to log in to Xiaohongshu inside the OpenClaw Chromium window. Run `openclaw browser`, navigate to `https://www.xiaohongshu.com`, and log in.

**Tools work in CLI but time out via agent**
This can happen right after a gateway restart while the browser control service is initializing. Wait 10–15 seconds and retry.

---

## License

MIT — see [LICENSE](./LICENSE).

This project is not affiliated with or endorsed by Xiaohongshu (小红书).
