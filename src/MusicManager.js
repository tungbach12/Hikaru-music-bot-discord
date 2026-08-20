const { spawn } = require('child_process');
const {
  createAudioPlayer, createAudioResource, NoSubscriberBehavior,
  AudioPlayerStatus, VoiceConnectionStatus, entersState, StreamType,
  joinVoiceChannel,
} = require('@discordjs/voice');
const { WARP_PROXY, YTDLP_PATH, CHILD_ENV, DEFAULT_VOLUME, YTDL_COOKIES, YTDL_COOKIES_FROM_BROWSER, YTDL_USER_AGENT } = require('./config');
const { swallowPipeErr, makePipeFast, makePipeEncode, blocks } = require('./stream');
const { buildPlayingEmbed, buildControlRow1, buildControlRow2 } = require('./PlayerUI');
const { loadState } = require('./state');

// StreamType mapping
const STREAM_TYPES = { WebmOpus: StreamType.WebmOpus, OggOpus: StreamType.OggOpus, Arbitrary: StreamType.Arbitrary };

class MusicManager {
  constructor() {
    this.queues = new Map();   // guildId -> queue object
    this.procs = new Map();    // guildId -> active processes
    this.players = new Map();  // guildId -> AudioPlayer (created once)

    // Auto-heal: when stream.js detects a YouTube bot-block, rotate happened.
    // Restart the SAME track from position 0 on the fresh WARP egress.
    blocks.on('block', ({ url }) => {
      for (const [gid, q] of this.queues) {
        const cur = q.tracks[q.currentIndex];
        if (cur && cur.url === url) {
          console.log(`[warp-heal] restarting ${url} on fresh egress for guild ${gid}`);
          q.seekTo = 0;
          q.seekPending = false;
          this.killProc(gid).then(() => {
            const player = this.players.get(gid);
            if (player) player.stop(true);
            this.playNext(gid);
          }).catch(() => {});
          break;
        }
      }
    });
  }

  // ── Queue ──────────────────────────────────────────────────

  getQueue(guildId) {
    if (!this.queues.has(guildId)) {
      this.queues.set(guildId, {
        tracks: [], currentIndex: -1, volume: DEFAULT_VOLUME,
        loop: 'off', shuffle: false, autoplay: false,
        stay: true,
        connection: null, channel: null, message: null,
        playing: false, paused: false,
        seekTo: 0, seekPending: false, trackStartedAt: 0,
        manualSkip: false,
      });
      // Restore persisted stay state (survives PM2 restarts)
      const saved = loadState();
      if (saved && typeof saved[guildId]?.stay === 'boolean') {
        this.queues.get(guildId).stay = saved[guildId].stay;
      }
    }
    return this.queues.get(guildId);
  }

  // ── Process tracking & cleanup ─────────────────────────────

  async killProc(guildId) {
    const p = this.procs.get(guildId);
    if (!p || p.killing) return;
    p.killing = true;
    try { await p.killAll(); } catch {}
    try {
      p.resource?.playStream?.off?.('error', swallowPipeErr);
      p.resource?.playStream?.destroy?.(new Error('SKIP'));
    } catch {}
    this.procs.delete(guildId);
  }

  // ── Player (created once per guild, idle listener set once) ─

  ensurePlayer(guildId) {
    if (this.players.has(guildId)) return this.players.get(guildId);

    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });

    player.on(AudioPlayerStatus.Idle, () => {
      const queue = this.getQueue(guildId);
      console.log(`[${guildId}] Track ended, loop=${queue.loop}, index=${queue.currentIndex}`);
      this.killProc(guildId).then(() => {
        // Skip/back already advanced the index — Idle must NOT advance again
        if (queue.manualSkip) { queue.manualSkip = false; this.playNext(guildId); return; }
        // Seek replay: keep current index (don't advance) — playNext restarts same track at seekTo
        if (queue.seekPending) {
          this.playNext(guildId);
          return;
        }
        if (queue.loop !== 'track') queue.currentIndex++;
        this.playNext(guildId);
      });
    });

    player.on('error', (err) => {
      console.error(`[player ${guildId}] error:`, err);
      this.killProc(guildId).then(() =>
        this.playNext(guildId).catch(e => console.error('[auto-skip error]', e)),
      );
    });

    this.players.set(guildId, player);
    return player;
  }

  // ── Search ─────────────────────────────────────────────────

  async search(query) {
    return new Promise((resolve, reject) => {
      // Cookies flags only (no -o - for dump-json search)
      const cookieArgs = [];
      if (YTDL_COOKIES) cookieArgs.push('--cookies', YTDL_COOKIES);
      else if (YTDL_COOKIES_FROM_BROWSER) cookieArgs.push('--cookies-from-browser', YTDL_COOKIES_FROM_BROWSER);
      if (YTDL_USER_AGENT) cookieArgs.push('--user-agent', YTDL_USER_AGENT);
      const searchArgs = ['--dump-json', '--no-playlist'];
      if (WARP_PROXY) searchArgs.push('--proxy', WARP_PROXY);
      const args = [
        ...searchArgs,
        '--default-search', 'ytsearch5', '--no-warnings',
        '--extractor-args', 'youtube:player_client=android,web,mweb',
        ...cookieArgs,
      ];
      args.push(query.match(/^https?:\/\//) ? query : `ytsearch5:${query}`);

      const proc = spawn(YTDLP_PATH, args, { env: CHILD_ENV });
      let stdout = '', stderr = '';
      proc.stdout.on('data', d => stdout += d);
      proc.stderr.on('data', d => stderr += d);
      proc.on('close', code => {
        if (code !== 0) return reject(new Error(stderr || 'yt-dlp failed'));
        try {
          const results = stdout.trim().split('\n').filter(Boolean).flatMap(line => {
            try {
              const info = JSON.parse(line);
              return [{
                id: info.id, title: info.title || 'Unknown',
                duration: info.duration || 0,
                uploader: info.uploader || info.channel || 'Unknown',
                url: info.webpage_url || info.url,
                thumbnail: info.thumbnail,
              }];
            } catch { return []; }
          });
          resolve(results);
        } catch (e) { reject(e); }
      });
      proc.on('error', reject);
    });
  }

  // ── Core: play next track ──────────────────────────────────

  async playNext(guildId) {
    const queue = this.getQueue(guildId);

    // Bounds check — queue empty or all tracks played
    if (queue.tracks.length === 0 || queue.currentIndex >= queue.tracks.length) {
    if (queue.loop === 'queue' && queue.tracks.length > 0) {
      queue.currentIndex = 0;
    } else {
      queue.playing = false;
      this.updatePlayerEmbed(queue);
      // Schedule disconnect if not staying
      if (!queue.stay && queue.onIdle) queue.onIdle(guildId);
      return;
    }
    }

    // Shuffle
    if (queue.shuffle && queue.currentIndex < queue.tracks.length) {
      const remaining = queue.tracks.length - queue.currentIndex;
      if (remaining > 1) {
        const swap = queue.currentIndex + Math.floor(Math.random() * remaining);
        [queue.tracks[queue.currentIndex], queue.tracks[swap]] =
          [queue.tracks[swap], queue.tracks[queue.currentIndex]];
      }
    }

    const track = queue.tracks[queue.currentIndex];
    if (!track) { queue.playing = false; return; }

    console.log(`[Player] ${track.title} (${queue.currentIndex + 1}/${queue.tracks.length})`);
    queue.playing = true;
    queue.paused = false;

    const url = track.url;
    if (!url?.startsWith('http')) {
      queue.currentIndex++;
      return this.playNext(guildId);
    }

    try {
      await this.killProc(guildId);

      // Seek offset: if a seek is pending, restart same track from seekTo position
      const startSec = queue.seekPending ? queue.seekTo : 0;
      queue.seekTo = startSec;  // keep seek base for getPosition; 0 for fresh tracks
      queue.seekPending = false;
      queue.trackStartedAt = Date.now();

      // Single-pipe: ALWAYS encode (verified 2026-08-16).
      // Fast opus pipe can't hold: YouTube SABR (Pitfall 41) strips audio-only
      // formats → fast pipe returns MP4/AAC (format 18), which @discordjs/voice
      // with StreamType.WebmOpus rejects → silence ("Did not find the EBML tag").
      // encode pipe converts MP4/AAC → WebM/Opus (~4s first bytes, EBML ✓).
      const enc = makePipeEncode(url, startSec);
      const pipe = { ytdlp: enc.ytdlp, ffmpeg: enc.ffmpeg, stdout: enc.stdout };
      const inputType = enc.type;

      const resource = createAudioResource(pipe.stdout, {
        inputType: STREAM_TYPES[inputType] || StreamType.Arbitrary,
      });
      resource.playStream?.on('error', swallowPipeErr);

      this.procs.set(guildId, {
        ...pipe, resource, killing: false,
        killAll: async () => {
          if (pipe.ffmpeg) {
            try { pipe.ytdlp?.stdout?.unpipe?.(pipe.ffmpeg?.stdin); } catch {}
            try { pipe.ffmpeg?.stdin?.end?.(); } catch {}
            try { pipe.ffmpeg?.kill?.('SIGTERM'); } catch {}
            await new Promise(r => setTimeout(r, 120));
            try { pipe.ffmpeg?.kill?.('SIGKILL'); } catch {}
          }
          try { pipe.ytdlp?.kill?.('SIGTERM'); } catch {}
          await new Promise(r => setTimeout(r, 100));
          try { pipe.ytdlp?.kill?.('SIGKILL'); } catch {}
        },
      });

      const player = this.ensurePlayer(guildId);
      if (queue.connection) queue.connection.subscribe(player);
      player.play(resource);
      this.updatePlayerEmbed(queue);
    } catch (error) {
      console.error('Play error:', error);
      queue.currentIndex++;
      this.playNext(guildId);
    }
  }

  // ── Public play (from /play command) ───────────────────────

  async play(guildId) { return this.playNext(guildId); }

  // ── Skip (explicit: killProc → stop → playNext) ────────────
  // Returns { ok, message } so the UI can tell the user when the queue is empty.

  async skip(guildId) {
    console.log(`[Player] Skip called`);
    const queue = this.getQueue(guildId);
    if (queue.tracks.length === 0) {
      return { ok: false, message: 'Queue trống — thêm bài trước đã!' };
    }
    const isLast = queue.currentIndex >= queue.tracks.length - 1;
    if (isLast && queue.loop !== 'queue') {
      return { ok: false, message: 'Đã hết queue — bật Loop 🔁 hoặc thêm bài mới.' };
    }
    queue.seekTo = 0;
    queue.seekPending = false;
    queue.manualSkip = true;   // Idle handler won't re-advance (see listener)
    await this.killProc(guildId);
    const player = this.players.get(guildId);
    if (player) player.stop(true);
    queue.currentIndex++;
    await this.playNext(guildId);
    return { ok: true, message: '⏭ Đã skip' };
  }

  // ── Seek (relative ± seconds; restarts current track at new position) ──
  // Returns { ok, position, duration } — position is the new playback position.

  async seek(guildId, deltaSeconds) {
    const queue = this.getQueue(guildId);
    const track = queue.tracks[queue.currentIndex];
    if (!track || !queue.playing) {
      return { ok: false, message: 'Không có bài đang phát để seek.' };
    }
    const duration = track.duration || 0;
    const current = this.getPosition(guildId);
    const target = Math.max(0, duration > 0 ? Math.min(current + deltaSeconds, duration) : current + deltaSeconds);
    queue.seekTo = target;
    queue.seekPending = true;
    await this.killProc(guildId);
    const player = this.players.get(guildId);
    if (player) player.stop(true);
    return { ok: true, position: target, duration };
  }

  // Current playback position in seconds (seek base + time since stream start)

  getPosition(guildId) {
    const queue = this.getQueue(guildId);
    const elapsed = queue.trackStartedAt ? (Date.now() - queue.trackStartedAt) / 1000 : 0;
    return (queue.seekTo || 0) + Math.max(0, elapsed);
  }

  // ── Stop ───────────────────────────────────────────────────
  // Stay semantics: with Stay ON the FIRST Stop only clears the queue and
  // keeps the bot in the channel (user: "stay instead of disconnect").
  // A second Stop (queue already empty & not playing) actually leaves.
  // Returns { ok, left, message }.

  async stop(guildId) {
    const queue = this.getQueue(guildId);
    const alreadyEmpty = queue.tracks.length === 0 && !queue.playing;
    queue.tracks = [];
    queue.currentIndex = -1;
    queue.playing = false;
    queue.paused = false;
    await this.killProc(guildId);
    const player = this.players.get(guildId);
    if (player) player.stop(true);
    // Stay ON + something was playing/queued → clear but STAY (never auto-leave)
    if (queue.stay && !alreadyEmpty) {
      return { ok: true, left: false, message: '⏹ Queue cleared — bot stays (Stay ON). Press Stop again to leave.' };
    }
    if (queue.connection) { queue.connection.destroy(); queue.connection = null; }
    this.disconnect(guildId);
    return { ok: true, left: true };
  }

  // ── Pause / Resume ─────────────────────────────────────────

  pause(guildId) {
    const queue = this.getQueue(guildId);
    const player = this.players.get(guildId);
    if (player && queue.playing) { player.pause(); queue.paused = true; }
  }

  resume(guildId) {
    const queue = this.getQueue(guildId);
    const player = this.players.get(guildId);
    if (player && queue.paused) { player.unpause(); queue.paused = false; }
  }

  // ── Volume ─────────────────────────────────────────────────

  setVolume(guildId, vol) {
    const queue = this.getQueue(guildId);
    queue.volume = Math.max(0, Math.min(100, vol));
  }

  // ── Stay / Disconnect ──────────────────────────────────────

  toggleStay(guildId) {
    const queue = this.getQueue(guildId);
    queue.stay = !queue.stay;
    return queue.stay;
  }

  // Load per-guild stay state after startup (survives PM2 restarts)
  loadStayState(saved) {
    if (!saved || typeof saved !== 'object') return;
    for (const [gid, s] of Object.entries(saved)) {
      if (s && typeof s.stay === 'boolean' && this.queues.has(gid)) {
        this.queues.get(gid).stay = s.stay;
      }
    }
  }

  disconnect(guildId) {
    this.queues.delete(guildId);
    this.players.delete(guildId);
    this.procs.delete(guildId);
  }

  // Re-join a voice channel after a restart if the guild had Stay ON.
  // Returns true if a channel was rejoined.
  async rejoinSavedChannel(client, saved) {
    let rejoined = 0;
    if (!saved || typeof saved !== 'object') return 0;
    for (const [gid, s] of Object.entries(saved)) {
      if (!s || s.stay !== true || !s.channelId) continue;
      const guild = client.guilds.cache.get(gid);
      if (!guild) continue;
      const channel = guild.channels.cache.get(s.channelId);
      if (!channel || !channel.isVoiceBased?.()) continue;
      try {
        const queue = this.getQueue(gid);   // restores stay=true from state
        queue.channel = channel;
        queue.connection = joinVoiceChannel({
          channelId: channel.id,
          guildId: gid,
          adapterCreator: guild.voiceAdapterCreator,
          selfDeaf: true,
        });
        queue.onIdle = (ggid) => { /* stay ON — never schedule leave */ };
        rejoined++;
        console.log(`[rejoin] Guild ${gid} re-joined ${channel.name} (Stay ON persists across restart)`);
      } catch (e) {
        console.warn(`[rejoin] Guild ${gid} failed:`, e.message);
      }
    }
    return rejoined;
  }

  // ── Shuffle / Loop ─────────────────────────────────────────

  toggleShuffle(guildId) {
    const queue = this.getQueue(guildId);
    queue.shuffle = !queue.shuffle;
    if (queue.shuffle && queue.tracks.length > 1) {
      const remaining = queue.tracks.slice(queue.currentIndex + 1);
      for (let i = remaining.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
      }
      queue.tracks = [...queue.tracks.slice(0, queue.currentIndex + 1), ...remaining];
    }
  }

  toggleLoop(guildId) {
    const queue = this.getQueue(guildId);
    const modes = ['off', 'track', 'queue'];
    queue.loop = modes[(modes.indexOf(queue.loop) + 1) % modes.length];
  }

  // ── Back (previous track) ──────────────────────────────────
  async back(guildId) {
    const queue = this.getQueue(guildId);
    if (queue.currentIndex <= 0) {
      return { ok: false, message: 'Đây là bài đầu — không có bài trước đó.' };
    }
    queue.seekTo = 0;
    queue.seekPending = false;
    queue.manualSkip = true;    // Idle won't re-advance (we move the index ourselves)
    await this.killProc(guildId);
    const player = this.players.get(guildId);
    if (player) player.stop(true);
    queue.currentIndex--;        // go to previous track
    await this.playNext(guildId);
    return { ok: true, message: '⏮ Đã về bài trước' };
  }

  // ── Embed update ───────────────────────────────────────────

  updatePlayerEmbed(queue) {
    if (!queue.channel) return;
    const track = queue.tracks[queue.currentIndex];
    if (!track) return;
    const embed = buildPlayingEmbed(track, queue);
    const row1 = buildControlRow1(false, queue.paused);
    const row2 = buildControlRow2(false, queue.shuffle, queue.loop === 'off', !queue.stay);

    // Delete old panel + send new one (keeps panel at bottom)
    if (queue.message) {
      queue.message.delete().catch(() => {});
    }
    queue.channel.send({ embeds: [embed], components: [row1, row2] })
      .then(msg => { queue.message = msg; })
      .catch(() => {});
  }

  // Edit in-place (for button toggles — fast, no new message)
  updatePlayerEmbedFast(queue) {
    if (!queue.message) return this.updatePlayerEmbed(queue);
    const track = queue.tracks[queue.currentIndex];
    if (!track) return;
    const embed = buildPlayingEmbed(track, queue);
    const row1 = buildControlRow1(false, queue.paused);
    const row2 = buildControlRow2(false, queue.shuffle, queue.loop === 'off', !queue.stay);
    queue.message.edit({ embeds: [embed], components: [row1, row2] }).catch(() => {
      // Message deleted — recreate
      this.updatePlayerEmbed(queue);
    });
  }
}

module.exports = MusicManager;
