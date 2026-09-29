# TelegraPi

Chat with your [Pi](https://github.com/earendil-works/pi) coding sessions from Telegram.

TelegraPi gives every Pi session its own topic in a private chat with your bot. Pi's answers stream into that topic as it types. When you reply there, the reply goes to that session as if you had typed it at the keyboard. With wake mode on, you can also start new sessions or resume stopped ones from your phone.

```text
Pi session A  ⇄  Telegram topic "project-a · 1a2b3c4d"
Pi session B  ⇄  Telegram topic "project-b · 5e6f7a8b"
```

## What you can do

- **Follow along live.** Pi's replies stream into the topic, along with what it is doing right now (thinking, which tool it is running, subagent progress).
- **Reply from anywhere.** Your message reaches that session: it starts a new turn if Pi is idle, or steers the current turn if Pi is busy. Sessions never see each other's messages.
- **Control the session with buttons.** Each topic has a pinned status card with **Continue**, **Stop**, **Retry**, and **Refresh status** buttons.
- **Answer Pi's questions.** When Pi asks a multiple-choice question, you get tap-to-answer buttons.
- **Exchange files.** Send Pi a photo or document; Pi can send reports, archives, and images back.
- **Run Pi commands.** Your Pi extension commands, prompt templates, and skills appear in Telegram's `/` menu.
- **Wake Pi remotely** (optional). Message a stopped session to resume it, create new sessions, clone a repository, or update Pi, all from the chat.

## Quick start

You need Pi 0.84.0+, Node.js 22.19.0+, and a Telegram account.

### 1. Create a bot

1. Open [@BotFather](https://t.me/BotFather), send `/newbot`, and keep the token it gives you.
2. Turn on topics for the bot: **Select bot → Bot Settings → Threaded Mode → Enable**.

Use a dedicated bot for TelegraPi. Topics live in your private chat with the bot, so you don't need a group.

### 2. Install

```bash
pi install git:github.com/JohnsonRan/pi-telegram-operator
```

### 3. Run setup

Close all running Pi sessions first, then run:

```bash
node "$HOME/.pi/agent/git/github.com/JohnsonRan/pi-telegram-operator/setup.cjs"
```

On Windows PowerShell, use `node "$env:USERPROFILE\.pi\agent\git\github.com\JohnsonRan\pi-telegram-operator\setup.cjs"`. If you set `PI_CODING_AGENT_DIR`, use that directory instead of `~/.pi/agent`.

Setup asks for the bot token (input is hidden), then asks you to send a one-time `/start <code>` message to the bot so it knows which Telegram account to trust. It also briefly creates and deletes a test topic to confirm Threaded Mode works.

### 4. Start Pi

Start Pi as usual. The first time a session sends something (a finished answer, a question, a notification), its topic appears in the bot chat. Reply in that topic to talk to the session.

## Using it

### Session topics

- Each top-level Pi session gets one topic, named after the session and its short ID. Subagents report through their parent and never get their own topic.
- Reply in a topic to send that text to the session. If the session is not running, the reply waits and is delivered when it reconnects (or wakes it, if wake mode is on).
- A 👀 reaction means your message was accepted.
- Only Pi's answer text is sent. Its thinking and raw tool output are not.

### Files

- **To Pi:** send a photo or document inside a session topic. It is saved to `<project>/.pi-telegram/inbox/` (Git-ignored) and Pi is asked to look at it. Limit: 20 MiB.
- **From Pi:** Pi can use the `telegram_send_file` tool to send a file from its working directory. Limit: 50 MiB. Files outside the project directory are refused.

### Questions

Pi can use the `telegram_ask_user_question` tool to ask you a question with answer buttons, and it waits for your tap. Questions Pi asks in the terminal (`ask_user_question`) still show up as a notification, but you answer them at the computer.

### Pi commands

Extension commands, prompt templates, and skills from your connected sessions are added to the bot's `/` menu. Names Telegram doesn't allow are converted, for example `/ctx-stats` → `/ctx_stats` and `/skill:frontend-design` → `/skill_frontend_design`. Pick one inside a session topic to run it in that session.

Built-in terminal-only commands such as `/model` or `/settings` are not available remotely.

## Wake mode (optional)

With wake mode, a message in a session's topic starts that exact session if no Pi window has it open. You can also create sessions from the bot's main chat view (**All Topics**).

> [!WARNING]
> Wake mode lets anyone who controls your Telegram account run Pi unattended: model calls, file edits, and commands. Keep the bot private and limit `wakeAllowedRoots` to directories you trust.

### Enable it

1. Edit `~/.pi/agent/pi-telegram-operator.json`:

   ```json
   {
     "wakeMode": true,
     "wakeDefaultCwd": "/home/me/code",
     "wakeAllowedRoots": ["/home/me/code"]
   }
   ```

   Keep the other keys setup wrote. On Windows, escape backslashes: `"D:\\code"`.

2. Restart any open Pi sessions so they load the new settings.

3. Install the background service so wake works even when no Pi is open:

   ```bash
   node "$HOME/.pi/agent/git/github.com/JohnsonRan/pi-telegram-operator/service.cjs" install
   ```

Woken sessions open in a new terminal window by default: Windows Console, macOS Terminal.app, or a common Linux terminal. You can keep working in that window when you're back at the computer. If no desktop or terminal is available, Pi runs in the background and the topic tells you why. Set `"wakeOpenTerminal": false` to always run in the background.

### Commands in All Topics

These work in the bot's main chat view (outside any session topic) when wake mode is on:

| Command | What it does |
| --- | --- |
| `/new <folder> \| <prompt>` | Create a session in that folder and start it with the prompt |
| `/new <folder>` | Create a session topic without starting Pi |
| `/new \| <prompt>` | Use `wakeDefaultCwd` as the folder |
| `/clone <repo-url> [name]` | Clone into `wakeDefaultCwd` and start a session there (`git clone <url>` also works) |
| `/sessions` | List known sessions, with **Restore + recap** buttons |
| `/status` | Show broker status |
| `/update` | Run `pi update --all` (`pi update --all` also works) |
| `/help` | Show this list |

**Restore + recap** resumes a session and asks Pi for a short summary of where it left off. Telegram doesn't let bots switch your screen to a topic, so open the topic (marked unread) yourself.

Folders must be inside `wakeAllowedRoots`. Symbolic links are resolved before the check.

### Managing the service

```bash
node "$HOME/.pi/agent/git/github.com/JohnsonRan/pi-telegram-operator/service.cjs" <command>
```

| Command | Effect |
| --- | --- |
| `install` | Register and start the service (reinstall after changing proxy settings) |
| `start` / `stop` | Start or stop the service |
| `status` | Show service status and the log file path |
| `uninstall` | Stop and remove the service; config and open Pi sessions are kept |

The service is a per-user Scheduled Task (`PiTelegramOperator`) on Windows, a LaunchAgent on macOS, and a systemd user unit on Linux. Stopping or restarting it never closes Pi sessions it opened; they reconnect automatically.

**After updating TelegraPi, restart the service** (`stop`, then `start`) so it loads the new code. Restart open Pi sessions too.

## Configuration

TelegraPi keeps these files in `~/.pi/agent` (or `PI_CODING_AGENT_DIR`):

| File | Contents |
| --- | --- |
| `pi-telegram-operator.secret` | Bot token only |
| `pi-telegram-operator.json` | Settings (below) |
| `pi-telegram-operator.state.json` | Topics, pending replies, and other runtime state; don't edit |
| `pi-telegram-operator.log` | Service log |

Settings in `pi-telegram-operator.json`:

| Key | Default | Meaning |
| --- | --- | --- |
| `chatId`, `allowedUserId` | set by setup | The only Telegram chat and user the bot listens to |
| `bridgeSecret` | generated | Secret used by local Pi processes to talk to each other |
| `port` | `43871` | Local port for that connection (`127.0.0.1` only) |
| `linkPreview` | `false` | Show link previews in messages |
| `apiBaseUrl` | `https://api.telegram.org` | Telegram Bot API endpoint (see [Network](#network)) |
| `wakeMode` | `false` | Enable [wake mode](#wake-mode-optional) |
| `wakeDefaultCwd` | `""` | Folder used by `/new \| …` and `/clone` |
| `wakeAllowedRoots` | `[]` | Folders wake mode may use; required when `wakeMode` is on |
| `wakeOpenTerminal` | `true` | Open woken sessions in a terminal window |
| `wakePiCommand` | `"pi"` | Command used to start Pi |
| `wakePiCommandArgs` | `[]` | Extra arguments for that command |

After editing settings, restart open Pi sessions and the service (`stop`, then `start`); they keep the old values until then. Rerunning setup keeps your settings as long as you authorize the same Telegram account.

## Network

### Can't reach api.telegram.org?

Set `apiBaseUrl` to a reverse proxy, mirror, or self-hosted [Bot API server](https://github.com/tdlib/telegram-bot-api), for example `http://127.0.0.1:8081`. Your bot token is sent to this address, so use only endpoints you trust. The address must not contain a username or password. Before moving a bot to your own Bot API server, call [`logOut`](https://core.telegram.org/bots/api#logout) on the official server once, as Telegram requires; you then cannot switch back to the official server for 10 minutes. The Bot API server's `--local` mode is not supported. To run setup through the same endpoint, set `TELEGRAM_API_BASE_URL` for that run; setup saves it as `apiBaseUrl`.

### Using an HTTP proxy

Node.js ignores `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1` is also set (Node 22.21+ or 24+):

```bash
export NODE_USE_ENV_PROXY=1
export HTTPS_PROXY=http://127.0.0.1:7890
export NO_PROXY=localhost,127.0.0.1
```

Set these wherever Pi and setup are started. For the background service:

- **macOS / Linux:** set them in your shell, then run `service.cjs install` again. They are saved into the service file, which only you can read (permissions 0600).
- **Windows:** set them as user environment variables (`setx NODE_USE_ENV_PROXY 1`, and so on), then restart the service. If the service still doesn't use the proxy, sign out of Windows and back in.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| No topic appears | Did you restart Pi after setup? Is Threaded Mode enabled in BotFather? |
| "No active Pi session is available" | You wrote in All Topics without wake mode. Reply inside a session topic instead. |
| Replies say "queued until the target Pi session reconnects" | That session isn't running. Open it in Pi, or enable wake mode. |
| Every notification arrives twice | If you use `pi-notify`, remove its Telegram command action. TelegraPi already reads its notifications. |
| Wake or `/update` fails on Windows with `ENOENT` or `EINVAL` | `wakePiCommand` is started without a shell, so an npm `pi.cmd` shim can't run. Set `wakePiCommand` to `node.exe` and `wakePiCommandArgs` to the full path of Pi's `dist/cli.js` (or point it at a real `pi.exe`). |
| Setup says the broker is running | Close all Pi sessions and stop the service, then rerun setup. |
| Service misbehaves after an update | Restart it with `service.cjs stop` and `start`, then check `status` and the log file. |

## Security

- Only messages from the configured chat **and** user are accepted; everything else is ignored.
- Local Pi processes talk over `127.0.0.1` only and must present `bridgeSecret`.
- Files are only read from and written to the session's working directory.
- Keep the files in `~/.pi/agent` private and never commit them.

## How it works

One Pi process (or the background service) acts as a local broker. It holds the only Telegram connection (long polling) and routes messages by topic. Every other Pi process connects to it over `127.0.0.1`. If the broker process exits, another process takes over automatically. Your replies are saved to disk until the target session confirms it received them. Old notification links and undelivered replies are removed after 30 days; topics are kept.

TelegraPi also listens to the `pi:semantic-hook:v1` event bus (`agent-notify`, `user-ready`), so notifications from `pi-notify` and similar extensions are forwarded to the session topic.

## Development

```bash
npm install
npm run check   # type check, syntax check, tests
```

CI runs the same check on Windows, macOS, and Linux.

| Path | Responsibility |
| --- | --- |
| `index.ts` | Pi extension entry: tools, notifications, hooks |
| `src/bridge/` | Pi-side connection to the local broker |
| `src/broker/` | Local broker, connected clients, durable state |
| `src/telegram/` | Telegram API, routing, formatting, controls, files |
| `src/session/` | Streaming and live status |
| `src/wake/` | Launching woken sessions and terminals |
| `src/shared/`, `src/service/` | Settings, paths, helpers, daemon logging |
| `setup.cjs`, `service.cjs`, `daemon.cjs` | Setup, service manager, background daemon |

## License

MIT
