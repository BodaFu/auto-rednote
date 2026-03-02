# auto-rednote

**OpenClaw extension for Xiaohongshu (小红书 / RedNote) automation.**

Reuses your already-logged-in Chrome via OpenClaw's browser control, giving an AI agent full access to Xiaohongshu web operations — no separate browser process, no API keys, no reverse-engineering.

[中文文档 →](./README.md)

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

## Tools (28 total)

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
| `xhs_search` | Search notes by keyword, sort, type, time range, scope |
| `xhs_get_feed` | Get note detail with comments |
| `xhs_get_sub_comments` | Get all sub-comments under a comment |
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
| `xhs_get_notifications_pending` | Get unprocessed notifications (for agent heartbeat loops) |
| `xhs_mark_notification` | Mark a notification as replied / skipped / retry |
| `xhs_notification_stats` | Get notification processing statistics |

### Publishing

| Tool | Description |
|---|---|
| `xhs_publish` | Publish an image or video note (supports text-only, scheduled publishing) |

### Desktop DM (Private Messages) — macOS only

> Requires the Xiaohongshu macOS app (rednote, available on the Mac App Store) running in **full-screen mode** on its own Space. The web version of Xiaohongshu does not support direct messages. Controlled via [peekaboo](https://github.com/nicklama/peekaboo) CLI.

| Tool | Description |
|---|---|
| `xhs_desktop_im_scan_inbox` | **Recommended** — Scan message list + return pre-computed click coordinates for all visible rows |
| `xhs_desktop_im_scan_stranger` | **Recommended** — Scan stranger message list + return "Reply" button coordinates |
| `xhs_desktop_im_unread` | Scan for unread DMs (legacy, prefer scan_inbox) |
| `xhs_desktop_im_inbox` | Take a screenshot of the DM inbox (no unread filtering) |
| `xhs_desktop_im_open` | Open a conversation by coordinates `(x, y)` or element ID |
| `xhs_desktop_im_send` | Send a message in the currently open conversation |
| `xhs_desktop_im_back` | Navigate back (taps the `<` button in the top-left) |
| `xhs_desktop_im_see` | List UI elements on screen (debug / dynamic element lookup) |
| `xhs_desktop_screenshot` | Take a screenshot of the current app state |

### Desktop Feed (Ghost OS) — macOS only

> Controls the Xiaohongshu macOS app via Ghost OS GUI automation, extracting data from the AX tree. More human-like behavior than web CDP, lower risk of triggering anti-bot measures.

| Tool | Description |
|---|---|
| `xhs_desktop_list_feeds` | Get recommended feed list from the desktop app |
| `xhs_desktop_search` | Search content in the desktop app |
| `xhs_desktop_get_feed` | Get note detail from the desktop app (matched by title) |
| `xhs_desktop_go_back` | Navigate back in the desktop app |

---

## Example agent workflows

### Auto-reply to new comments

```
User: Check for new Xiaohongshu comments and reply "Thanks for your support!"

Agent flow:
1. xhs_check_login           → confirm logged in
2. xhs_get_notifications_pending { maxPages: 2 }
3. filter comment_on_my_note / reply_to_my_comment types
4. xhs_reply_comment { feedId, xsecToken, commentId, content: "Thanks for your support!" }
5. xhs_mark_notification { id, status: "replied" }
```

### Reply to private messages (DMs)

```
User: Check my Xiaohongshu DMs and reply to any unread messages

Agent flow:
1. xhs_desktop_im_scan_inbox → screenshot of Messages tab + row coordinates
2. visually analyse screenshot to find unread conversations and their clickX/clickY
3. xhs_desktop_im_open { x, y }    → opens conversation, screenshot shows message history
4. read message content from screenshot
5. xhs_desktop_im_send { text: "..." }  → sends reply
6. verify reply appears in screenshot
7. xhs_desktop_im_back       → return to inbox for next message
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

- **HTTP browser control**: The extension communicates with the OpenClaw Gateway's browser control HTTP service using native `fetch()`. This avoids `jiti` module isolation issues and ensures stable Playwright connections through the Gateway's single managed browser instance.
- **SPA warm-up**: Xiaohongshu is a React SPA. The extension ensures Chrome has visited the homepage to initialize `window.__INITIAL_STATE__` before extracting data.
- **Data extraction**: Prioritizes structured data from `window.__INITIAL_STATE__`; falls back to DOM parsing. Includes Vue reactive Proxy deep-unwrapping logic.
- **API interception**: Notification fetching intercepts `/api/sns/web/v1/you/mentions`. Comment reply injects a continuous `fetch`/XHR interceptor (`window.__commentAPIEntries`) to handle virtualized rendering and multi-level threads.
- **Multi-level comment handling**: `xhs_reply_comment` implements a 4-level fallback strategy to locate comments in virtualized lists, including inferring true parent IDs from intercepted API data.
- **Notification state**: Uses Node.js built-in `node:sqlite` to persist notification processing state in a local SQLite database.
- **Navigation reliability**: Three-layer retry mechanism (URL verification → forced re-navigation → open new tab). CDP navigate returning success does not guarantee the page has loaded.
- **Desktop DM — Space switching**: The Xiaohongshu macOS app runs in its own full-screen Space. `activateApp` uses `System Events set frontmost to true` (the only mechanism that switches Spaces programmatically) rather than `tell application X to activate` (which only activates the process without switching Spaces). Screenshots are taken with `screencapture -R` after the Space animation completes (~800 ms).
- **Desktop DM — iOS on Mac limitations**: The app is an iOS port; its Accessibility tree has very low fidelity (most elements labelled "button" or "text"). The tools degrade gracefully: `peekaboo see` failures fall back to pure visual analysis of the screenshot. Clicks use absolute screen coordinates derived from the known window region (x=0, y=33, 1512×949 for a full-screen display).
- **Desktop Feed — Ghost OS**: Controls the Xiaohongshu macOS app GUI via Ghost OS CLI, extracting feed data through deep AX tree traversal. Does not depend on web `__INITIAL_STATE__`. More human-like behavior, lower anti-bot risk.

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

## Changelog

### v2026.3.1

- **New: Desktop Feed tools (Ghost OS)** — 4 new `xhs_desktop_*` tools for GUI-based Xiaohongshu macOS app control
  - `xhs_desktop_list_feeds`, `xhs_desktop_search`, `xhs_desktop_get_feed`, `xhs_desktop_go_back`
- **New**: `xhs_search` now supports sort, note type, time range, and search scope filters
- **Removed**: Rate-limiting cooldown mechanism for web tools

### v2026.2.25

- **New: Desktop DM tools** — 9 new `xhs_desktop_*` tools for replying to private messages via the Xiaohongshu macOS app
  - `xhs_desktop_im_scan_inbox`, `xhs_desktop_im_scan_stranger`, `xhs_desktop_im_unread`, `xhs_desktop_im_inbox`, `xhs_desktop_im_open`, `xhs_desktop_im_send`, `xhs_desktop_im_back`, `xhs_desktop_im_see`, `xhs_desktop_screenshot`
- Fixed full-screen Space switching: `activateApp` now uses `System Events set frontmost` to correctly cross Space boundaries
- Fixed screenshot capture from other Spaces: `screenshot()` activates the app and waits 800 ms for the animation before calling `screencapture`
- Calibrated UI coordinates for full-screen 1512×949 layout (input box y=930, back button y=30)
- `xhs_search`: added `limit` parameter (default 20) to control result count

### v2026.2.24

- Overhauled notification parsing and comment-finding logic
- Added `injectCommentAPIInterceptor` for continuous API response collection
- Rewrote `scrollToComment` and `expandAndFindSubComment` with stall detection and `has_more` handling
- Completed `replyComment` 4-level fallback paths
- Fixed `followUser` ReferenceError
- Enhanced `parseCommentApiResponse` to return `subCommentCount` / `subCommentHasMore`

### v2026.2.22

- Initial release with 19 core tools
- Full coverage: account, content, interaction, notifications, publishing

---

## License

MIT — see [LICENSE](./LICENSE).

This project is not affiliated with or endorsed by Xiaohongshu (小红书).
