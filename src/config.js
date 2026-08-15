require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

module.exports = {
  TOKEN: process.env.DISCORD_TOKEN,
  CLIENT_ID: process.env.CLIENT_ID,
  // WARP_PROXY: empty string = disable proxy (direct egress).
  // Only fall back to the socks default when the var is entirely unset.
  WARP_PROXY: process.env.WARP_PROXY === undefined || process.env.WARP_PROXY === null
    ? 'socks5://127.0.0.1:40000'
    : process.env.WARP_PROXY,
  YTDLP_PATH: process.env.YTDLP_PATH || 'yt-dlp',
  FFmpeg_PATH: process.env.FFMPEG_PATH || 'ffmpeg',
  YTDL_COOKIES: process.env.YTDL_COOKIES || '',
  YTDL_COOKIES_FROM_BROWSER: process.env.YTDL_COOKIES_FROM_BROWSER || '',
  YTDL_USER_AGENT: process.env.YTDL_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  CHILD_ENV: {
    ...process.env,
    PATH: `/home/ubuntu/.deno/bin:${process.env.PATH}`,
  },
  DEFAULT_VOLUME: 80,
  MAX_QUEUE: 100,
  BLUE: 0x00b0f4,
  DARK: 0x1a1a2e,
  // Read from .env, default 10000 (10s) — NOT hardcoded 300 (which broke
  // ready for any stream taking >300ms to first byte → always fallback).
  YTDL_TIMEOUT_MS: Number(process.env.YTDL_TIMEOUT_MS) || 10000,
};
