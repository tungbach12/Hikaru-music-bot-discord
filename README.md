# 🎵 Hikaru Music Bot

Discord music bot streaming YouTube via yt-dlp + Cloudflare WARP proxy + ffmpeg → @discordjs/voice.

## Features

- 🎵 YouTube playback (URL or search)
- ⏭️ Skip / ⏮️ Back / ⏸️ Pause / ▶️ Resume / ⏹️ Stop
- 🔀 Shuffle / 🔁 Loop (off/track/queue)
- 🔊 Volume control (0-100%)
- 📋 Queue management
- 🎨 Dark theme MUSIC PANEL embed with control buttons
- 🔄 Two-pipe: fast WebM/Opus → fallback ffmpeg encode
- 🛡️ Graceful shutdown (SIGINT/SIGTERM)

## Quick Install (One-Click)

```bash
# Install everything (Node.js, ffmpeg, yt-dlp, deno, Cloudflare WARP, bot)
curl -fsSL https://raw.githubusercontent.com/tungbach12/Hikaru-music-bot-discord/main/install.sh | sudo bash
```

Then configure:

```bash
# Edit your bot token and client ID
nano ~/music-bot/.env

# Restart
pm2 restart music-bot
```

### What the script installs

1. **Node.js 22** — JavaScript runtime
2. **Deno** — yt-dlp runtime environment
3. **yt-dlp** — YouTube audio extractor
4. **ffmpeg** — audio encoding (Opus/WebM)
5. **Cloudflare WARP** — bypasses YouTube IP blocks from VPS
6. **Bot code** — clone repo + npm install + pm2 start

### After install — Edit `.env`

```env
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_client_id_here
WARP_PROXY=socks5://127.0.0.1:40000
YTDLP_PATH=yt-dlp
FFMPEG_PATH=ffmpeg
```

## Manual Install (step by step)

```bash
# System dependencies
sudo apt install -y curl git ffmpeg lsb-release gnupg2

# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt install -y nodejs

# Deno
curl -fsSL https://deno.land/install.sh | sh

# yt-dlp
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod +x /usr/local/bin/yt-dlp

# Cloudflare WARP
curl -fsSL https://pkg.cloudflareclient.com/install.sh | sudo bash
sudo warp-cli registration new   # type 'y' to agree to TOS
sudo warp-cli mode proxy
sudo warp-cli proxy port 40000
sudo warp-cli connect

# Bot
git clone https://github.com/tungbach12/Hikaru-music-bot-discord.git ~/music-bot
cd ~/music-bot
npm install
cp .env.example .env
nano .env              # add your token + client ID

# Start with PM2
pm2 start src/index.js --name music-bot
pm2 save
pm2 startup             # auto-start on reboot
```

## Architecture

```
src/
├── config.js          ← .env + constants
├── stream.js          ← swallowPipeErr, makePipeFast, makePipeEncode
├── PlayerUI.js        ← embed + button builders
├── MusicManager.js    ← core class (play, skip, queue, volume)
├── commands/
│   └── index.js       ← slash command definitions
└── index.js           ← client setup + event routing
```

## Commands

- `/play <query>` — Play a song from YouTube
- `/skip` — Skip current song
- `/stop` — Stop and clear queue
- `/pause` — Pause playback
- `/resume` — Resume playback
- `/queue` — Show current queue
- `/nowplaying` — Show current song
- `/volume <0-100>` — Set volume
- `/shuffle` — Toggle shuffle
- `/loop` — Toggle loop (off/track/queue)

## PM2 Commands

```bash
pm2 status              # check bot status
pm2 logs music-bot      # view logs
pm2 restart music-bot   # restart
pm2 stop music-bot      # stop
```

## License

MIT
