const { spawn } = require('child_process');
const {
  createAudioPlayer, createAudioResource, NoSubscriberBehavior,
  AudioPlayerStatus, VoiceConnectionStatus, entersState, StreamType,
} = require('@discordjs/voice');
const { WARP_PROXY, YTDLP_PATH, CHILD_ENV, DEFAULT_VOLUME } = require('./config');
const { swallowPipeErr, makePipeFast, makePipeEncode } = require('./stream');
const { buildPlayingEmbed, buildControlRow1, buildControlRow2 } = require('./PlayerUI');

// StreamType mapping
const STREAM_TYPES = { WebmOpus: StreamType.WebmOpus, OggOpus: StreamType.OggOpus, Arbitrary: StreamType.Arbitrary };

class MusicManager {
  constructor() {
    this.queues = new Map();   // guildId -> queue object
    this.procs = new Map();    // guildId -> active processes
    this.players = new Map();  // guildId -> AudioPlayer (created once)
  }

  // ── Queue ──────────────────────────────────────────────────

  getQueue(guildId) {
    if (!this.queues.has(guildId)) {
      this.queues.set(guildId, {
        tracks: [], currentIndex: -1, volume: DEFAULT_VOLUME,
        loop: 'off', shuffle: false, autoplay: false,
        stay: false,
        connection: null, channel: null, message: null,
        playing: false, paused: false,
      });
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
      const args = [
        '--proxy', WARP_PROXY, '--dump-json', '--no-playlist',
        '--default-search', 'ytsearch5', '--no-warnings',
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

      // Two-pipe: fast → fallback
      const fast = makePipeFast(url);
      const okFast = await fast.ready;
      let pipe, inputType;

      if (okFast) {
        pipe = { ytdlp: fast.ytdlp, stdout: fast.stdout };
        inputType = fast.type;
      } else {
        await fast.killAll();
        const enc = makePipeEncode(url);
        pipe = { ytdlp: enc.ytdlp, ffmpeg: enc.ffmpeg, stdout: enc.stdout };
        inputType = enc.type;
      }

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

  async skip(guildId) {
    console.log(`[Player] Skip called`);
    await this.killProc(guildId);
    const player = this.players.get(guildId);
    if (player) player.stop(true);
    this.getQueue(guildId).currentIndex++;
    await this.playNext(guildId);
  }

  // ── Stop ───────────────────────────────────────────────────

  async stop(guildId) {
    const queue = this.getQueue(guildId);
    queue.tracks = [];
    queue.currentIndex = -1;
    queue.playing = false;
    queue.paused = false;
    queue.stay = false;
    await this.killProc(guildId);
    const player = this.players.get(guildId);
    if (player) player.stop(true);
    if (queue.connection) { queue.connection.destroy(); queue.connection = null; }
    this.disconnect(guildId);
  }

  // ── Pause / Resume ─────────────────────────────────────────

  pause(guildId) {
    const queue = this.getQueue(guildId);
    const player = this.players.get(guildId);
    if (player && queue.playing) { player.pause(); queue.paused = true; this.updatePlayerEmbed(queue); }
  }

  resume(guildId) {
    const queue = this.getQueue(guildId);
    const player = this.players.get(guildId);
    if (player && queue.paused) { player.unpause(); queue.paused = false; this.updatePlayerEmbed(queue); }
  }

  // ── Volume ─────────────────────────────────────────────────

  setVolume(guildId, vol) {
    const queue = this.getQueue(guildId);
    queue.volume = Math.max(0, Math.min(100, vol));
    this.updatePlayerEmbed(queue);
  }

  // ── Stay / Disconnect ──────────────────────────────────────

  toggleStay(guildId) {
    const queue = this.getQueue(guildId);
    queue.stay = !queue.stay;
    return queue.stay;
  }

  disconnect(guildId) {
    this.queues.delete(guildId);
    this.players.delete(guildId);
    this.procs.delete(guildId);
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
    this.updatePlayerEmbed(queue);
  }

  toggleLoop(guildId) {
    const queue = this.getQueue(guildId);
    const modes = ['off', 'track', 'queue'];
    queue.loop = modes[(modes.indexOf(queue.loop) + 1) % modes.length];
    this.updatePlayerEmbed(queue);
  }

  // ── Back (previous track) ──────────────────────────────────

  back(guildId) {
    const queue = this.getQueue(guildId);
    if (queue.currentIndex > 0) {
      queue.currentIndex -= 2; // skip() will increment
      return this.skip(guildId);
    }
  }

  // ── Embed update ───────────────────────────────────────────

  updatePlayerEmbed(queue) {
    if (!queue.message) return;
    const track = queue.tracks[queue.currentIndex];
    if (!track) return;
    const embed = buildPlayingEmbed(track, queue);
    const row1 = buildControlRow1(false, queue.paused);
    const row2 = buildControlRow2(false, queue.shuffle, queue.loop === 'off');
    queue.message.edit({ embeds: [embed], components: [row1, row2] }).catch(() => {});
  }
}

module.exports = MusicManager;
