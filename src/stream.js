const { spawn } = require('child_process');
const { WARP_PROXY, YTDLP_PATH, FFmpeg_PATH, CHILD_ENV, YTDL_TIMEOUT_MS, YTDL_COOKIES, YTDL_USER_AGENT, YTDL_COOKIES_FROM_BROWSER } = require('./config');

function ytdlpBaseArgs() {
  const args = [
    '--no-warnings',
    '-q',
    '-o', '-',
  ];
  // Only add --proxy when an actual proxy is configured (empty = direct egress).
  if (WARP_PROXY) args.push('--proxy', WARP_PROXY);
  if (YTDL_COOKIES) args.push('--cookies', YTDL_COOKIES);
  else if (YTDL_COOKIES_FROM_BROWSER) args.push('--cookies-from-browser', YTDL_COOKIES_FROM_BROWSER);
  if (YTDL_USER_AGENT) args.push('--user-agent', YTDL_USER_AGENT);
  // player_client ORDER matters for latency (2026-08-15):
  //   android ALONE → first byte ~2.6s (fast, no JS challenge)
  //   web,android,mweb → first byte ~8.6s (web runs deno JS challenge first)
  // android covers format 18 + most audio; web/mweb are fallbacks for
  // videos where android gets SABR-only. Put android FIRST.
  args.push('--extractor-args', 'youtube:player_client=android,web,mweb');
  args.push('-4');          // IPv4 only (YouTube IPv6 egress gets flagged harder)
  args.push('-N', '4');     // concurrent download connections → faster first bytes
  return args;
}

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
 * @param {string} url - media URL
 * @param {number} start - seek offset in seconds (0 = from beginning)
 */
function makePipeFast(url, start = 0) {
  const args = [
    ...ytdlpBaseArgs(),
    '-f', '18/bestaudio[acodec=opus][ext=webm]/bestaudio[acodec=opus]',
    '--no-playlist',
  ];
  if (start > 0) args.push('--download-sections', `*${start}-`);
  args.push(url);

  const y = spawn(YTDLP_PATH, args, { env: CHILD_ENV, stdio: ['ignore', 'pipe', 'pipe'] });

  y.stderr.on('data', (d) => console.log(`[yt-dlp fast] ${d}`));

  const ready = new Promise((resolve) => {
    let done = false;
    const ok = () => { if (!done) { done = true; clearTimeout(to); resolve(true); } };
    const fail = () => { if (!done) { done = true; clearTimeout(to); resolve(false); } };
    const to = setTimeout(fail, YTDL_TIMEOUT_MS);
    // FIX (2026-08-15): rely on stderr "ERROR" lines, NOT close/exit.
    // On fast downloads yt-dlp writes all stdout, exits (close) BEFORE the
    // data listener can observe it → false "ready:false" → unnecessary fallback.
    y.stdout.once('data', ok);
    // Treat a clean exit (code 0) with zero bytes as failure too.
    y.once('close', (code) => {
      if (code !== 0) fail();
    });
    y.stderr.on('data', (d) => {
      const line = String(d);
      if (/ERROR:|Sign in to confirm|Requested format is not available|HTTP Error 403/i.test(line)) fail();
    });
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
 * @param {string} url - media URL
 * @param {number} start - seek offset in seconds (0 = from beginning)
 */
function makePipeEncode(url, start = 0) {
  const args = [
    ...ytdlpBaseArgs(),
    '-f', 'bestaudio/best',
    '--no-playlist',
  ];
  if (start > 0) args.push('--download-sections', `*${start}-`);
  args.push(url);

  const y = spawn(YTDLP_PATH, args, { env: CHILD_ENV, stdio: ['ignore', 'pipe', 'pipe'] });

  const f = spawn(FFmpeg_PATH, [
    '-loglevel', 'error', '-nostdin',
    '-probesize', '32', '-analyzeduration', '0',
    '-fflags', 'nobuffer', '-flags', 'low_delay',
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

module.exports = { swallowPipeErr, makePipeFast, makePipeEncode, ytdlpBaseArgs };
