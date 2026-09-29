# TelegraPi

`pi-telegram-operator` is a threaded Telegram operator for [Pi](https://github.com/earendil-works/pi).

Each Pi session gets its own topic in the bot's private chat. Telegram replies are injected as real Pi user messages, and assistant text is streamed with Telegram's native `sendMessageDraft` API before being persisted as a normal message.

## Features

- One private Telegram topic per top-level Pi session
- Subagent processes (`PI_SUBAGENT_CHILD=1`) stay inside their parent session and do not create topics
- Native streaming assistant responses
- Live main-agent turn/tool status, including `pi-subagents` child progress when available
- Safe Markdown-to-Telegram-HTML rendering for headings, emphasis, code, links, quotes, spoilers, and lists
- Notification replies become `pi.sendUserMessage()` input
- Multiple concurrent Pi processes share one localhost broker and one `getUpdates` poller
- Optional always-on wake daemon resumes a stopped Pi session when its topic receives a message
- The unthreaded All Topics view provides explicit `/new`, `/sessions`, `/status`, and `/help` control commands
- Pi extension, prompt-template, and skill commands are synchronized into Telegram's bot command menu
- Cross-platform per-user services support Windows Scheduled Tasks, macOS LaunchAgents, and Linux systemd user units
- Replies route by `message_thread_id`, so agents cannot consume each other's messages
- Busy sessions receive Telegram input as `steer`; idle sessions start a normal turn
- Consumes `pi:semantic-hook:v1` notifications from `pi-notify` and other neutral producers
- Bot token stays in a dedicated plain secret file, separate from JSON configuration

## Requirements

- Pi 0.84.0 or newer
- Node.js 22.19.0 or newer
- A dedicated Telegram bot with **Threaded Mode** enabled

Enable Threaded Mode in `@BotFather`:

```text
Select bot -> Bot Settings -> Threaded Mode -> Enable
```

Threaded Mode must be enabled in the bot's private chat. A forum supergroup is not required.

## Install

```bash
pi install git:github.com/JohnsonRan/pi-telegram-operator
```

Restart Pi after installation.

## Configure

Run the interactive setup utility from the installed Git checkout:

```bash
node "$HOME/.pi/agent/git/github.com/JohnsonRan/pi-telegram-operator/setup.cjs"
```

If `PI_CODING_AGENT_DIR` points somewhere else, replace `$HOME/.pi/agent` with that directory. When developing from a clone, run `node setup.cjs` in the repository root. Stop all Pi sessions before rerunning setup so there is no competing Telegram `getUpdates` poller.

The setup process:

1. Reads the BotFather token without echoing it.
2. Verifies the bot with `getMe`.
3. Uses a one-time `/start <nonce>` message to identify the authorized Telegram account.
4. Creates a temporary private topic and calls `sendMessageDraft` to verify Threaded Mode.
5. Deletes the temporary validation topic.
6. Writes the configuration files under `$PI_CODING_AGENT_DIR` (normally `~/.pi/agent`).

Files:

| File | Purpose |
| --- | --- |
| `pi-telegram-operator.secret` | Telegram bot token only |
| `pi-telegram-operator.json` | Allowed chat/user, localhost broker secret, and port |
| `pi-telegram-operator.state.json` | Update offset, session/topic mappings, notification mappings, pending replies, and pending questions |

Example non-secret configuration:

```json
{
  "chatId": 123456789,
  "allowedUserId": 123456789,
  "bridgeSecret": "generated-random-value",
  "port": 43871,
  "linkPreview": false,
  "apiBaseUrl": "https://api.telegram.org",
  "wakeMode": true,
  "wakeDefaultCwd": "F:\\",
  "wakeAllowedRoots": ["F:\\"],
  "wakePiCommand": "pi",
  "wakePiCommandArgs": [],
  "wakeOpenTerminal": true
}
```

`linkPreview` defaults to `false`, which disables URL previews on notifications and persisted assistant messages. Set it to `true` to opt back in. Telegram's ephemeral `sendMessageDraft` method does not expose link preview options.

`apiBaseUrl` defaults to `https://api.telegram.org`. Point it at a reverse proxy, mirror, or self-hosted [Bot API server](https://github.com/tdlib/telegram-bot-api) (for example `http://127.0.0.1:8081`) when the official endpoint is unreachable. The bot token is sent to this URL, so only use endpoints you trust. The server's `--local` mode is not supported because it returns local file paths instead of downloadable files. To run setup itself through a custom endpoint, set `TELEGRAM_API_BASE_URL` for that run; setup stores it as `apiBaseUrl`.

### HTTP proxy

Node's built-in `fetch` ignores `HTTP_PROXY`/`HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1` is also set (Node 22.21+ or 24+). Set all of them in the environment that starts Pi, setup, or the daemon:

```bash
export NODE_USE_ENV_PROXY=1
export HTTPS_PROXY=http://127.0.0.1:7890
export NO_PROXY=localhost,127.0.0.1
```

The localhost broker bridge is a raw TCP socket and never uses the proxy; keep `127.0.0.1` in `NO_PROXY` if `apiBaseUrl` points at a local Bot API server. On macOS and Linux, `service.cjs install` copies these variables from the installing shell into the LaunchAgent or systemd unit, so rerun `install` after changing them; credentials in a proxy URL are then stored in that service file. On Windows the Scheduled Task uses your user environment variables, so set them with `setx` (or System Properties) and restart the service.

## Wake daemon

Set `wakeMode` to `true` to let Telegram start Pi when no interactive Pi process owns the target session. `wakeDefaultCwd` is used by `/new | <prompt>`, and every requested working directory must resolve inside one of the `wakeAllowedRoots`. Symbolic links and junctions are resolved before the allowlist check.

Wake requests open Pi in a foreground terminal by default. Interactive mode omits `--print`, keeps the Pi TUI running after the Telegram turn, and lets you continue the same session from the keyboard when you return to the computer.

- Windows opens a new console window through PowerShell 7 (`pwsh`) when available, with Windows PowerShell as a fallback.
- macOS activates Terminal.app and opens a new tab.
- Linux detects `x-terminal-emulator`, GNOME Terminal, Konsole, xfce4-terminal, or xterm in that order.

If no graphical desktop or supported terminal is available, Pi automatically falls back to headless mode and reports the reason in Telegram. Desktop focus-stealing rules may cause the new terminal to flash in the taskbar or dock instead of taking focus. Set `wakeOpenTerminal` to `false` to always use the headless one-shot behavior:

```text
pi --session-id <id> --name <name> --print --approve <prompt>
```

Only the configured `allowedUserId` can issue wake requests. One wake process may run per session; additional messages are delivered through the normal authenticated broker connection.

Install the per-user service from the installed checkout:

```bash
node "$HOME/.pi/agent/git/github.com/JohnsonRan/pi-telegram-operator/service.cjs" install
```

Stop the daemon and remove the per-user service registration:

```bash
node "$HOME/.pi/agent/git/github.com/JohnsonRan/pi-telegram-operator/service.cjs" uninstall
```

This keeps the installed checkout, configuration, daemon log, and Pi sessions previously opened by wake mode.

The install command selects the native service manager for the current platform:

- Windows: hidden `PiTelegramOperator` per-user Scheduled Task (no persistent console window)
- macOS: `~/Library/LaunchAgents/com.johnsonran.pi-telegram-operator.plist`
- Linux: `~/.config/systemd/user/pi-telegram-operator.service`

Service lifecycle commands are `install`, `start`, `stop`, `status`, and `uninstall`. The daemon writes bounded diagnostics to `~/.pi/agent/pi-telegram-operator.log`; `status` also prints the resolved log path. If another broker owns the port, the daemon waits and takes ownership automatically after that process exits. Service stop, restart, reinstall, and update operations terminate only the broker daemon; Pi sessions previously opened by wake mode remain running and reconnect to the replacement broker.

A running daemon keeps its loaded code after the package checkout updates. Restart it before testing a newly installed version:

```bash
node "$HOME/.pi/agent/git/github.com/JohnsonRan/pi-telegram-operator/service.cjs" stop
node "$HOME/.pi/agent/git/github.com/JohnsonRan/pi-telegram-operator/service.cjs" start
```

All Topics is command-only:

```text
/update
pi update --all
/clone https://github.com/owner/repository.git
/clone git@github.com:owner/repository.git local-name
git clone https://github.com/owner/repository.git
/new F:\\project | inspect this project
/new F:\\project
/new | use the configured default directory
/sessions
/status
/help
```

`/update` and the equivalent `pi update --all` form run the exact Pi update command without a shell, return bounded command output to Telegram, and remind you to restart running Pi sessions so updated extensions are loaded.

`/clone` and the equivalent `git clone` form clone one HTTPS or SSH repository into `wakeDefaultCwd`, create a private session topic for the repository, and start Pi with the cloned repository as its working directory. An optional destination must be a single safe directory name; absolute paths, parent traversal, shell operators, and arbitrary Git options are rejected. The configured default directory must remain inside `wakeAllowedRoots`.

The `/help`, `/status`, and `/sessions` responses include inline buttons for switching between the control views and refreshing live status without typing another command. Known sessions also get `Restore + recap` buttons: pressing one verifies the saved topic, recreates it if it was deleted, resumes the exact host Pi session, and asks Pi to post a concise recap of the recovered objective, decisions, completed work, and next steps. Telegram does not provide a Bot API method or supported private-topic deep link that can force the client to navigate into an existing topic, so the restored topic is marked unread and the callback tells the user to open it. Callback actions are restricted to the configured chat and allowed user.

Messages in an existing session topic wake that exact session. Ordinary unthreaded text never falls back to a globally "latest" session.

## Rich Telegram interaction

- Send a document or photo inside a session topic to save it under `<cwd>/.pi-telegram/inbox/` and ask that exact Pi session to inspect it. Downloads are limited to 20 MiB and sanitized filenames never escape the session directory.
- Pi can call `telegram_send_file` to return a generated document, report, archive, or image from its working directory. Uploads are limited to 50 MiB and paths outside the session directory are rejected.
- Every session topic gets one pinned status dashboard that is edited in place with connection, working, question, upload, and ready states.
- Dashboard and notification buttons provide Continue, Stop, Retry, and Refresh status actions. Stop calls Pi's abort API directly instead of injecting a textual command.
- Pi can call `telegram_ask_user_question` to render multiple-choice Telegram buttons and wait for the selected answer in the same tool call. Regular local `ask_user_question` prompts still produce a notification but remain local to Pi's terminal UI.
- Accepted Telegram messages receive a non-blocking 👀 reaction after they are delivered, queued, or used to start the matching Pi session. Telegram does not expose a normal Bot API method for changing the client's true unread state.
- Telegram chat actions show typing and document-upload activity while Pi is working.

## Pi command menu

For each connected session, the extension reads `pi.getCommands()` and synchronizes invokable extension commands, prompt templates, and skills into Telegram with `setMyCommands`. Names that Telegram cannot represent directly are converted to stable lowercase aliases, for example `/ctx-stats` becomes `/ctx_stats` and `/skill:frontend-design` becomes `/skill_frontend_design`.

Selecting an alias inside a session topic restores the original Pi command and dispatches it with `expandPromptTemplates: true`. The command mapping is stored with the topic, so it also works when that topic must wake a stopped session. Non-command wake prompts are transferred through the child environment instead of being exposed as CLI arguments.

Telegram permits at most 100 bot commands. Wake controls occupy four entries, and up to 96 discovered Pi commands are published. Built-in interactive-only TUI commands such as `/model`, `/settings`, and `/hotkeys` are intentionally excluded because Pi does not expose them through `getCommands()` and they cannot execute through a remote prompt. Commands that open custom terminal UI may still require an interactive Pi window; prompt templates, skills, and headless extension commands work normally.

Wake mode permits unattended model calls, file writes, and command execution. Keep the bot private and restrict `wakeAllowedRoots` to trusted directories.

## pi-notify integration

This extension listens directly to the neutral `pi:semantic-hook:v1` bus.

Recognized hooks:

- `agent-notify` with `TITLE` and `CONTENT`
- `user-ready` with `STOP_KIND` and `REASON`

It also listens directly for `ask_user_question` tool starts. `pi-notify` may remain installed for BEL/OSC notifications and for its optional `agent_notify` tool, but its Telegram command action should be removed to avoid duplicate pushes.

## Message routing

```text
Pi session A -> Telegram topic A -> reply -> Pi session A
Pi session B -> Telegram topic B -> reply -> Pi session B
```

A single localhost broker owns Telegram long polling. Every Pi process connects to it using a random secret. If the broker-owning Pi process exits, another connected process can become the broker after reconnecting.

Reply delivery uses ACKs. A reply stays in durable state until the target Pi process confirms that `sendUserMessage()` accepted it. Notification mappings and undelivered replies expire after 30 days and are pruned every six hours; topic mappings are retained so resumed Pi sessions continue using their existing Telegram topics.

## Streaming

Assistant text is observed through Pi's `message_start`, `message_update`, and `message_end` lifecycle events.

- `sendMessageDraft` updates are throttled to avoid one HTTP request per token and back off once when Telegram returns `429 retry_after`.
- Drafts use the session's private topic.
- Pi Markdown is converted to Telegram's supported HTML subset on every draft update, so partial Markdown remains balanced and safe.
- Supported formatting includes headings, bold, italic, strikethrough, spoilers, inline/fenced code, links, blockquotes, and readable list markers.
- Raw HTML and unsafe link protocols are escaped rather than trusted.
- If Telegram rejects formatted entities, delivery retries once as plain text.
- The final response is persisted with `sendMessage`.
- Responses longer than Telegram's message limit are split at line boundaries when possible.
- Thinking blocks and tool-call payloads are not forwarded; only assistant text content is streamed.

## Security

- Use a dedicated bot.
- The configured `chatId` and `allowedUserId` must both match incoming messages.
- The broker binds only to `127.0.0.1`.
- Local broker frames require the generated `bridgeSecret`.
- Do not commit any files from `~/.pi/agent` to this repository.

## Development

```bash
npm install
npm run check
```

GitHub Actions runs the same check on Windows, macOS, and Linux. The Windows job also executes the hidden VBS daemon launcher and verifies that it waits for the child process and preserves its exit code.

The runtime is organized by responsibility:

- `src/runtime.cjs` is the public composition facade.
- `src/bridge/` owns Pi-side broker communication and framing.
- `src/broker/` owns the local leader, connected clients, and durable routing state.
- `src/telegram/` owns Telegram HTTP, routing, formatting, controls, cloning, and updates.
- `src/session/` owns assistant streaming and live agent status.
- `src/wake/` owns wake processes, terminal launch, and wake payloads.
- `src/shared/` and `src/service/` contain shared settings, paths, time formatting, and daemon logging.

## License

MIT
