# Contributing to auto-rednote

Thank you for your interest in contributing!

## Development setup

```bash
git clone https://github.com/BodaFu/auto-rednote.git
cd /path/to/openclaw/extensions
ln -s /path/to/auto-rednote auto-rednote   # or clone directly here
cd auto-rednote && npm install
```

You need a running OpenClaw instance with browser control enabled to test changes.

## Project structure

```
auto-rednote/
├── index.ts                  # Tool registration (OpenClaw plugin entry)
├── openclaw.plugin.json      # Plugin metadata and config schema
├── package.json
└── src/
    ├── types.ts              # All TypeScript interfaces
    ├── state.ts              # SQLite notification state management
    ├── browser.ts            # OpenClaw browser control HTTP client
    └── actions/
        ├── login.ts          # xhs_check_login, xhs_get_qrcode
        ├── feeds.ts          # xhs_list_feeds, xhs_search, xhs_get_feed, xhs_get_user, xhs_my_*
        ├── interact.ts       # xhs_post_comment, xhs_reply_comment, xhs_like, xhs_collect, xhs_follow
        ├── notifications.ts  # xhs_get_notifications, xhs_get_notifications_pending, xhs_mark_*, xhs_notification_stats
        └── publish.ts        # xhs_publish
```

## Guidelines

- All code must be **TypeScript** (no `.js` files in `src/`)
- Use **ES Modules** (`import`/`export`), not CommonJS
- Use **pnpm** or **npm** — do not commit `yarn.lock`
- Keep tool descriptions in `index.ts` accurate and agent-friendly
- Test with a real OpenClaw + Chrome setup before submitting a PR

## Submitting changes

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/your-feature`
3. Commit with a clear message
4. Open a Pull Request against `main`

## Reporting issues

Please include:
- OpenClaw version
- Node.js version
- The tool name and parameters used
- Relevant log output from the OpenClaw gateway
