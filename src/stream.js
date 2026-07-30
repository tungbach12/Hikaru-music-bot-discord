const { spawn } = require('child_process');
const { WARP_PROXY, YTDLP_PATH, FFmpeg_PATH, CHILD_ENV, YTDL_TIMEOUT_MS } = require('./config');

/**
 * Suppress harmless pipe errors (EPIPE, ECONNRESET, premature close)
 */
function swallowPipeErr(e) {
  if (!e) return;
  const code = e.code || '';
  const msg = String(e.message || e);
  if (
    code === 'EPIPE' ||
    code === 'ECONNRESET' ||
    code === 'ERR_STREAM_PREMATURE_CLOSE' ||
    /EOF|socket hang up|premature|broken pipe/i.test(msg)
  ) return;
  console.warn('[stream error]', code, msg);
}

/**
 * Fast pipe: yt-dlp outputs WebM/Opus directly (no ffmpeg re-encode).
 * Resolves true if data arrives within 300ms, false otherwise.
 */
function makePipeFast(url) {
  const y = spawn(YTDLP_PATH, [
    '--proxy', WARP_PROXY,
    '-f', 'bestaudio[acodec=opus][ext=webm]/bestaudio[acodec=opus]',
    '--no-playlist', '--no-warnings',
    '-q', '-o', '-', url,
  ], { env: CHILD_ENV, stdio: ['ignore', 'pipe', 'pipe'] });

  y.stderr.on('data', (d) => console.log(`[yt-dlp fast] ${d}`));

  const ready = new Promise((resolve) => {
    let done = false;
    const ok = () => { if (!done) { done = true; clearTimeout(to); resolve(true); } };
    const fail = () => { if (!done) { done = true; clearTimeout(to); resolve(false); } };
    const to = setTimeout(fail, YTDL_TIMEOUT_MS);
    y.stdout.once('data', ok);
    y.once('close', fail);
  });

  y.stdout.on('error', swallowPipeErr);

  const killAll = async () => {
    try { y.stdout.unpipe(); } catch {}
    try { y.kill('SIGTERM'); } catch {}
    await new Promise(r => setTimeout(r, 120));
    try { y.kill('SIGKILL'); } catch {}
  };

  return { ytdlp: y, stdout: y.stdout, ready, killAll, type: 'WebmOpus' };
}

/**
 * Encode pipe: yt-dlp → ffmpeg (re-encode to WebM/Opus).
 * Fallback when fast pipe doesn't produce data quickly.
 */
function makePipeEncode(url, seekSeconds = 0) {
  const ytdlpArgs = [
    '--proxy', WARP_PROXY,
    '-f', 'bestaudio/best',
    '--no-playlist', '--no-warnings',
    '-q', '-o', '-', url,
  ];
  // Add seek position via download-sections
  if (seekSeconds > 0) {
    const h = String(Math.floor(seekSeconds / 3600)).padStart(2, '0');
    const m = String(Math.floor((seekSeconds % 3600) / 60)).padStart(2, '0');
    const s = String(Math.floor(seekSeconds % 60)).padStart(2, '0');
    ytdlpArgs.splice(-1, 0, '--download-sections', `*${h}:${m}:${s}-`);
  }
  const y = spawn(YTDLP_PATH, ytdlpArgs, { env: CHILD_ENV, stdio: ['ignore', 'pipe', 'pipe'] });

  const f = spawn(FFmpeg_PATH, [
    '-loglevel', 'error',
    '-i', 'pipe:0',
    '-vn', '-acodec', 'libopus',
    '-ar', '48000', '-ac', '2', '-b:a', '128k',
    '-f', 'webm', 'pipe:1',
  ], { env: CHILD_ENV, stdio: ['pipe', 'pipe', 'pipe'] });

  y.stderr.on('data', (d) => console.log(`[yt-dlp encode] ${d}`));
  f.stderr.on('data', (d) => console.log(`[ffmpeg] ${d}`));

  y.stdout.pipe(f.stdin);
  y.stdout.on('error', swallowPipeErr);
  f.stdin.on('error', swallowPipeErr);

  const safeUnpipe = () => {
    try { y.stdout.unpipe(f.stdin); } catch {}
    try { f.stdin.end(); } catch {}
  };

  f.on('close', () => { safeUnpipe(); try { y.kill('SIGKILL'); } catch {} });
  y.on('close', () => { safeUnpipe(); });

  const killAll = async () => {
    safeUnpipe();
    try { f.kill('SIGTERM'); } catch {}
    await new Promise(r => setTimeout(r, 150));
    try { f.kill('SIGKILL'); } catch {}
    try { y.kill('SIGTERM'); } catch {}
    await new Promise(r => setTimeout(r, 120));
    try { y.kill('SIGKILL'); } catch {}
  };

  return { ytdlp: y, ffmpeg: f, stdout: f.stdout, killAll, type: 'WebmOpus' };
}

module.exports = { swallowPipeErr, makePipeFast, makePipeEncode };
