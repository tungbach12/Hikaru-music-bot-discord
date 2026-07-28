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

## Prerequisites

- Node.js 16+
- ffmpeg
- yt-dlp
- Cloudflare WARP (for YouTube access from VPS)
- deno (for yt-dlp runtime)

## Setup

```bash
# Clone
git clone https://github.com/YOUR_USERNAME/hikaru-music-bot.git
cd hikaru-music-bot

# Install
npm install

# Configure
cp .env.example .env
# Edit .env with your bot token and client ID

# Start
pm2 start src/index.js --name music-bot
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

| Command | Description |
|---------|-------------|
| `/play <query>` | Play a song from YouTube |
| `/skip` | Skip current song |
| `/stop` | Stop and clear queue |
| `/pause` | Pause playback |
| `/resume` | Resume playback |
| `/queue` | Show current queue |
| `/nowplaying` | Show current song |
| `/volume <0-100>` | Set volume |
| `/shuffle` | Toggle shuffle |
| `/loop` | Toggle loop (off/track/queue) |

## License

MIT
