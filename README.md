# 🎵 Hikaru Music Bot

> Lightweight Discord music bot streaming YouTube via yt-dlp + Cloudflare WARP + ffmpeg.

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-339933.svg)](https://nodejs.org)
[![discord.js](https://img.shields.io/badge/discord.js-14-5865F2.svg)](https://discord.js.org)
[![yt-dlp](https://img.shields.io/badge/yt--dlp-latest-red.svg)](https://github.com/yt-dlp/yt-dlp)

## Features

- 🎵 **YouTube streaming** — search by name or paste URL
- ⏭️ **Playback controls** — Skip, Back, Pause, Resume, Stop
- 🔀 **Queue management** — Shuffle, Loop (off/track/queue)
- 🔊 **Volume control** (0–100%) via command or button
- 🎨 **Dark theme MUSIC PANEL** embed with two-row control layout
- 🔄 **Two-pipe streaming** — fast WebM/Opus → fallback to ffmpeg encode
- 🛡️ **Graceful shutdown** — SIGINT/SIGTERM handler
- 🐳 **Docker-ready** — PM2 native or containerized deployment

## Quick Install (One-Click)

The installer handles every dependency — Node.js, Deno, yt-dlp, ffmpeg, and **Cloudflare WARP** for YouTube access from VPS.

```bash
curl -fsSL https://raw.githubusercontent.com/tungbach12/Hikaru-music-bot-discord/main/install.sh | sudo bash
```

Then configure and restart:

```bash
nano ~/music-bot/.env      # add DISCORD_TOKEN + CLIENT_ID
pm2 restart music-bot
```

### What gets installed

| Package | Purpose |
|---------|---------|
| Node.js 22.x | JavaScript runtime |
| Deno | yt-dlp runtime environment |
| yt-dlp | YouTube audio extractor |
| ffmpeg | Audio encoding (Opus/WebM) |
| Cloudflare WARP | Bypasses YouTube IP blocks (SOCKS5 proxy) |
| PM2 | Process manager |

## Manual Install

### Prerequisites

- **Node.js** ≥ 22
- **ffmpeg** — `apt install ffmpeg`
- **yt-dlp** — [latest release](https://github.com/yt-dlp/yt-dlp/releases)
- **Deno** — [deno.land/install](https://deno.land/install.sh)
- **Cloudflare WARP** — for VPS deployments (YouTube IP block bypass)

### Steps

```bash
# 1. Clone
git clone https://github.com/tungbach12/Hikaru-music-bot-discord.git ~/music-bot
cd ~/music-bot

# 2. Install dependencies
npm install

# 3. Configure
cp .env.example .env
# Edit .env with your DISCORD_TOKEN and CLIENT_ID

# 4. Setup WARP (skip if running locally, not on VPS)
warp-cli registration new      # accept TOS with 'y'
warp-cli mode proxy
warp-cli proxy port 40000
warp-cli connect

# 5. Start with PM2
npm install -g pm2
pm2 start src/index.js --name music-bot
pm2 save
pm2 startup
```

### `.env` Configuration

```env
DISCORD_TOKEN=your_bot_token_here         # required
CLIENT_ID=your_client_id_here             # required
WARP_PROXY=socks5://127.0.0.1:40000       # WARP SOCKS5 (default)
YTDLP_PATH=yt-dlp                          # yt-dlp binary path
FFMPEG_PATH=ffmpeg                         # ffmpeg binary path
```

### PM2 Cheat Sheet

```bash
pm2 status              # view all processes
pm2 logs music-bot      # tail logs
pm2 restart music-bot   # apply config changes
pm2 stop music-bot      # graceful stop
pm2 monit               # CPU/RAM dashboard
```

## Architecture

```
src/
├── config.js          ← .env + constants (colors, paths, defaults)
├── stream.js          ← swallowPipeErr + makePipeFast + makePipeEncode
├── PlayerUI.js        ← embed + button builders
├── MusicManager.js    ← core class (play, skip, queue, volume, shuffle, loop)
├── commands/
│   └── index.js       ← slash command definitions
└── index.js           ← Discord client + event routing
```

### Streaming Pipeline

1. **Fast pipe** — `yt-dlp` outputs WebM/Opus directly (300ms timeout)
2. **Encode fallback** — `yt-dlp → ffmpeg` re-encode if fast pipe times out
3. **IDLE listener set ONCE** — no race conditions on skip/stop
4. **Process cleanup** — SIGTERM → SIGKILL cascade with delays
5. **EPIPE suppression** — harmless pipe errors don't crash the player

## Commands

| Command | Description |
|---------|-------------|
| `/play <query>` | Play a song from YouTube (URL or search) |
| `/skip` | Skip current song |
| `/back` | Previous track |
| `/stop` | Stop and clear queue |
| `/pause` | Pause playback |
| `/resume` | Resume playback |
| `/queue` | Show current queue |
| `/nowplaying` | Show current song |
| `/volume <0–100>` | Set volume |
| `/shuffle` | Toggle shuffle |
| `/loop` | Toggle loop (off / track / queue) |

## Embed Layout

```
┌─────────────────────────────────────┐
│ 🎵 MUSIC PANEL                      │
│                                     │
│ Now Playing:                        │
│ [Track Title](URL)                  │
│                                     │
│ 👤 Requested by │ ⏱️ Duration │ 🎤 Author │
│                                     │
│ Queue: 1/3 │ Volume: 80% │ 🔁 Loop: off │
└─────────────────────────────────────┘
[🔉 Vol– ⏮ Back ⏸ Pause ⏭ Skip 🔊 Vol+]
[🔀 Shuffle 🔁 Loop ⏹ Stop 🔄 Auto 📋 Queue]
```

## Common Issues

### "Sign in to confirm you're not a bot"

YouTube blocks datacenter IPs. **Solution:** Cloudflare WARP proxies your YouTube traffic through residential IPs.

```bash
warp-cli status   # should show "Connected"
curl --proxy socks5://127.0.0.1:40000 -I https://youtube.com   # should return 200
```

### WARP disconnects after reboot

```bash
sudo warp-cli connect   # reconnect on every boot
```

Add to `crontab -e`: `@reboot sleep 10 && sudo warp-cli connect`

### No audio despite correct embed

Check process logs:

```bash
pm2 logs music-bot --lines 30
```

Common causes: ffmpeg killed mid-stream (EPIPE → handled), WARP disconnected, Discord voice region issue.

## License

MIT
