require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder, REST, Routes, Partials } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, NoSubscriberBehavior, AudioPlayerStatus, VoiceConnectionStatus, entersState, StreamType } = require('@discordjs/voice');
const { spawn } = require('child_process');

// ============================================================
// CONFIG
// ============================================================
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const WARP_PROXY = process.env.WARP_PROXY || 'socks5://127.0.0.1:40000';
const YTDLP_PATH = process.env.YTDLP_PATH || 'yt-dlp';
const FFmpeg_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const DENO_PATH = '/home/ubuntu/.deno/bin';
const CHILD_ENV = { ...process.env, PATH: `${DENO_PATH}:${process.env.PATH}` };
const DEFAULT_VOLUME = 80;
const MAX_QUEUE = 100;
const BLUE = 0x00b0f4;
const DARK = 0x1a1a2e;

// ============================================================
// STREAM HELPERS
// ============================================================

/** Suppress harmless pipe errors (EPIPE, ECONNRESET, premature close) */
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
 * Returns a promise that resolves `true` if data arrives within 300ms,
 * `false` otherwise (caller should fall back to encode pipe).
 */
function makePipeFast(url) {
  const y = spawn(YTDLP_PATH, [
    '--proxy', WARP_PROXY,
    '-f', 'bestaudio[acodec=opus][ext=webm]/bestaudio[acodec=opus]',
    '--no-playlist',
    '--no-warnings',
    '-q',
    '-o', '-',
    url,
  ], { env: CHILD_ENV, stdio: ['ignore', 'pipe', 'pipe'] });

  y.stderr.on('data', (d) => {
    console.log(`[yt-dlp fast] ${d}`);
  });

  // First-byte readiness check: 300ms timeout
  const ready = new Promise((resolve) => {
    let resolved = false;
    const to = setTimeout(() => { if (!resolved) { resolved = true; resolve(false); } }, 300);
    y.stdout.once('data', () => { if (!resolved) { resolved = true; clearTimeout(to); resolve(true); } });
    y.once('close', () => { if (!resolved) { resolved = true; clearTimeout(to); resolve(false); } });
  });

  y.stdout.on('error', swallowPipeErr);

  const killAll = async () => {
    try { y.stdout.unpipe(); } catch {}
    try { y.kill('SIGTERM'); } catch {}
    await new Promise(r => setTimeout(r, 120));
    try { y.kill('SIGKILL'); } catch {}
  };

  return { ytdlp: y, stdout: y.stdout, ready, killAll, type: StreamType.WebmOpus };
}

/**
 * Encode pipe: yt-dlp → ffmpeg (re-encode to WebM/Opus).
 * Used as fallback when fast pipe doesn't produce data quickly.
 */
function makePipeEncode(url) {
  const y = spawn(YTDLP_PATH, [
    '--proxy', WARP_PROXY,
    '-f', 'bestaudio/best',
    '--no-playlist',
    '--no-warnings',
    '-q',
    '-o', '-',
    url,
  ], { env: CHILD_ENV, stdio: ['ignore', 'pipe', 'pipe'] });

  const f = spawn(FFmpeg_PATH, [
    '-loglevel', 'error',
    '-i', 'pipe:0',
    '-vn',
    '-acodec', 'libopus',
    '-ar', '48000',
    '-ac', '2',
    '-b:a', '128k',
    '-f', 'webm',
    'pipe:1',
  ], { env: CHILD_ENV, stdio: ['pipe', 'pipe', 'pipe'] });

  y.stderr.on('data', (d) => {
    console.log(`[yt-dlp encode] ${d}`);
  });
  f.stderr.on('data', (d) => {
    console.log(`[ffmpeg] ${d}`);
  });

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

  return { ytdlp: y, ffmpeg: f, stdout: f.stdout, killAll, type: StreamType.WebmOpus };
}

// ============================================================
// MUSIC MANAGER
// ============================================================
class MusicManager {
  constructor() {
    this.queues = new Map();  // guildId -> { tracks, currentIndex, volume, loop, shuffle, ... }
    this.procs = new Map();   // guildId -> { ytdlp, ffmpeg, resource, killAll, killing }
    this.players = new Map(); // guildId -> AudioPlayer (created once, idle listener never re-attached)
  }

  getQueue(guildId) {
    if (!this.queues.has(guildId)) {
      this.queues.set(guildId, {
        tracks: [],
        currentIndex: -1,
        volume: DEFAULT_VOLUME,
        loop: 'off', // off | track | queue
        shuffle: false,
        autoplay: false,
        connection: null,
        channel: null,
        message: null,
        playing: false,
        paused: false,
      });
    }
    return this.queues.get(guildId);
  }

  // ----------------------------------------------------------
  // PROC TRACKING & CLEANUP
  // ----------------------------------------------------------

  async killProc(guildId) {
    const p = this.procs.get(guildId);
    if (!p) return;
    if (p.killing) return;
    p.killing = true;

    try { await p.killAll(); } catch {}

    try {
      p.resource?.playStream?.off?.('error', swallowPipeErr);
      p.resource?.playStream?.destroy?.(new Error('SKIP'));
    } catch {}

    this.procs.delete(guildId);
  }

  // ----------------------------------------------------------
  // PLAYER (created once per guild, idle listener set once)
  // ----------------------------------------------------------

  ensurePlayer(guildId) {
    if (this.players.has(guildId)) return this.players.get(guildId);

    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });

    // Idle listener set ONCE — never removed or re-added
    player.on(AudioPlayerStatus.Idle, () => {
      console.log(`[${guildId}] Track ended cleanly`);
      this.killProc(guildId).then(() => {
        this.playNext(guildId);
      });
    });

    player.on('error', (err) => {
      console.error(`[player ${guildId}] error:`, err);
      this.killProc(guildId).then(() => {
        this.playNext(guildId).catch((e) => {
          console.error('[auto-skip error]', e);
        });
      });
    });

    this.players.set(guildId, player);
    return player;
  }

  // ----------------------------------------------------------
  // SEARCH
  // ----------------------------------------------------------

  async search(query) {
    return new Promise((resolve, reject) => {
      const args = [
        '--proxy', WARP_PROXY,
        '--dump-json',
        '--no-playlist',
        '--default-search', 'ytsearch5',
        '--no-warnings',
      ];

      // Check if it's a URL
      if (query.match(/^https?:\/\//)) {
        args.push(query);
      } else {
        args.push(`ytsearch5:${query}`);
      }

      const proc = spawn(YTDLP_PATH, args, { env: CHILD_ENV });
      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (d) => stdout += d);
      proc.stderr.on('data', (d) => stderr += d);

      proc.on('close', (code) => {
        if (code !== 0) {
          return reject(new Error(stderr || 'yt-dlp failed'));
        }
        try {
          const lines = stdout.trim().split('\n').filter(Boolean);
          const results = [];
          for (const line of lines) {
            try {
              const info = JSON.parse(line);
              results.push({
                id: info.id,
                title: info.title || 'Unknown',
                duration: info.duration || 0,
                uploader: info.uploader || info.channel || 'Unknown',
                url: info.webpage_url || info.url,
                thumbnail: info.thumbnail,
                isPlaylist: false,
              });
            } catch (e) { /* skip bad lines */ }
          }
          resolve(results);
        } catch (e) {
          reject(e);
        }
      });

      proc.on('error', reject);
    });
  }

  // ----------------------------------------------------------
  // PLAY NEXT (core audio pipeline)
  // ----------------------------------------------------------

  async playNext(guildId) {
    const queue = this.getQueue(guildId);

    // Get next track based on loop/shuffle settings
    if (queue.tracks.length === 0 || queue.currentIndex >= queue.tracks.length) {
      if (queue.loop === 'queue' && queue.tracks.length > 0) {
        queue.currentIndex = 0;
      } else {
        queue.playing = false;
        this.updatePlayerEmbed(queue);
        return;
      }
    }

    // Shuffle: swap next track with a random one in the remaining queue
    if (queue.shuffle && queue.currentIndex < queue.tracks.length) {
      const remaining = queue.tracks.length - queue.currentIndex;
      if (remaining > 1) {
        const swap = queue.currentIndex + Math.floor(Math.random() * remaining);
        [queue.tracks[queue.currentIndex], queue.tracks[swap]] = [queue.tracks[swap], queue.tracks[queue.currentIndex]];
      }
    }

    const track = queue.tracks[queue.currentIndex];
    if (!track) {
      queue.playing = false;
      return;
    }

    console.log(`[Player] Starting play: ${track.title} (${queue.currentIndex + 1}/${queue.tracks.length})`);
    queue.playing = true;
    queue.paused = false;

    const url = track.url;
    if (typeof url !== 'string' || !url.startsWith('http')) {
      console.log(`[Player] Invalid URL: ${String(url)}`);
      queue.currentIndex++;
      this.playNext(guildId);
      return;
    }

    try {
      // Kill any leftover processes from previous track
      await this.killProc(guildId);

      // Two-pipe approach: fast (direct WebM/Opus) → fallback (ffmpeg encode)
      console.log(`[Player] Spawning yt-dlp fast pipe for ${url}`);
      const fast = makePipeFast(url);
      const okFast = await fast.ready;

      let pipe, inputType;
      if (okFast) {
        console.log(`[Player] Fast pipe succeeded`);
        pipe = { ytdlp: fast.ytdlp, stdout: fast.stdout };
        inputType = fast.type;
      } else {
        // Fallback: ffmpeg encode
        console.log(`[Player] Fast pipe failed, falling back to ffmpeg encode`);
        await fast.killAll();
        const enc = makePipeEncode(url);
        pipe = { ytdlp: enc.ytdlp, ffmpeg: enc.ffmpeg, stdout: enc.stdout };
        inputType = enc.type;
      }

      const resource = createAudioResource(pipe.stdout, { inputType });
      resource.playStream?.on('error', (err) => {
        console.log(`[Player] Stream error: ${err.message || err}`);
        swallowPipeErr(err);
      });

      // Track the active processes for this guild
      this.procs.set(guildId, {
        ...pipe,
        resource,
        killing: false,
        killAll: async () => {
          if (pipe.ffmpeg) {
            console.log(`[${guildId}] Killing ffmpeg`);
            try { pipe.ytdlp?.stdout?.unpipe?.(pipe.ffmpeg?.stdin); } catch {}
            try { pipe.ffmpeg?.stdin?.end?.(); } catch {}
            try { pipe.ffmpeg?.kill?.('SIGTERM'); } catch {}
            await new Promise(r => setTimeout(r, 120));
            try { pipe.ffmpeg?.kill?.('SIGKILL'); } catch {}
          }
          console.log(`[${guildId}] Killing yt-dlp`);
          try { pipe.ytdlp?.kill?.('SIGTERM'); } catch {}
          await new Promise(r => setTimeout(r, 100));
          try { pipe.ytdlp?.kill?.('SIGKILL'); } catch {}
        },
      });

      // Get/create player and subscribe to connection
      const player = this.ensurePlayer(guildId);
      if (queue.connection) {
        queue.connection.subscribe(player);
      }

      // Play (idle listener is already attached from ensurePlayer)
      player.play(resource);

      // Update embed
      this.updatePlayerEmbed(queue);

    } catch (error) {
      console.error('Play error:', error);
      queue.currentIndex++;
      this.playNext(guildId);
    }
  }

  // ----------------------------------------------------------
  // PUBLIC PLAY (called from /play command)
  // ----------------------------------------------------------

  async play(guildId) {
    return this.playNext(guildId);
  }

  // ----------------------------------------------------------
  // SKIP (explicit: killProc → player.stop(true) → playNext)
  // ----------------------------------------------------------

  async skip(guildId) {
    const queue = this.getQueue(guildId);
    console.log(`[Player] Skip called — killing old processes`);

    // (a) Kill old processes first
    await this.killProc(guildId);

    // (b) player.stop(true) — force stop
    const player = this.players.get(guildId);
    if (player) {
      player.stop(true);
    }

    // (c) Move index and explicitly call playNext (do NOT rely on Idle event)
    queue.currentIndex++;
    await this.playNext(guildId);
  }

  // ----------------------------------------------------------
  // STOP
  // ----------------------------------------------------------

  async stop(guildId) {
    const queue = this.getQueue(guildId);
    queue.tracks = [];
    queue.currentIndex = -1;
    queue.playing = false;
    queue.paused = false;

    await this.killProc(guildId);

    const player = this.players.get(guildId);
    if (player) {
      player.stop(true);
    }

    if (queue.connection) {
      queue.connection.destroy();
      queue.connection = null;
    }

    this.queues.delete(guildId);
    this.players.delete(guildId);
    this.procs.delete(guildId);
  }

  // ----------------------------------------------------------
  // PAUSE / RESUME / VOLUME / SHUFFLE / LOOP
  // ----------------------------------------------------------

  pause(guildId) {
    const queue = this.getQueue(guildId);
    const player = this.players.get(guildId);
    if (player && queue.playing) {
      player.pause();
      queue.paused = true;
      this.updatePlayerEmbed(queue);
    }
  }

  resume(guildId) {
    const queue = this.getQueue(guildId);
    const player = this.players.get(guildId);
    if (player && queue.paused) {
      player.unpause();
      queue.paused = false;
      this.updatePlayerEmbed(queue);
    }
  }

  setVolume(guildId, vol) {
    const queue = this.getQueue(guildId);
    queue.volume = Math.max(0, Math.min(100, vol));
    this.updatePlayerEmbed(queue);
  }

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
    const idx = modes.indexOf(queue.loop);
    queue.loop = modes[(idx + 1) % modes.length];
    this.updatePlayerEmbed(queue);
  }

  // ----------------------------------------------------------
  // EMBED
  // ----------------------------------------------------------

  updatePlayerEmbed(queue) {
    if (!queue.message) return;

    const track = queue.tracks[queue.currentIndex];
    if (!track) return;

    const formatTime = (s) => {
      if (!s) return '0:00';
      const m = Math.floor(s / 60);
      const sec = Math.floor(s % 60);
      return `${m}:${sec.toString().padStart(2, '0')}`;
    };

    const loopEmoji = queue.loop === 'track' ? '🔂' : queue.loop === 'queue' ? '🔁' : '➡️';
    const shuffleEmoji = queue.shuffle ? '🔀' : '➡️';
    const pauseEmoji = queue.paused ? '▶️' : '⏸️';
    const statusEmoji = queue.playing ? (queue.paused ? '⏸️' : '▶️') : '⏹️';

    const embed = new EmbedBuilder()
      .setColor(BLUE)
      .setTitle('🎵 MUSIC PANEL')
      .setDescription(`**Now Playing:**\n[${track.title}](${track.url})`)
      .addFields(
        { name: '👤 Requested by', value: track.requestedBy || 'Unknown', inline: true },
        { name: '⏱️ Duration', value: formatTime(track.duration), inline: true },
        { name: '🎤 Author', value: track.uploader || 'Unknown', inline: true },
      )
      .setThumbnail(track.thumbnail)
      .setFooter({ text: `Queue: ${queue.currentIndex + 1}/${queue.tracks.length} | Volume: ${queue.volume}% | ${loopEmoji} Loop: ${queue.loop}` })
      .setTimestamp();

    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('vol_down').setLabel('🔉').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('back').setLabel('⏮').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('pause').setLabel(pauseEmoji).setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('skip').setLabel('⏭').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('vol_up').setLabel('🔊').setStyle(ButtonStyle.Secondary),
    );

    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('shuffle').setLabel('🔀').setStyle(queue.shuffle ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('loop').setLabel('🔁').setStyle(queue.loop !== 'off' ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('stop').setLabel('⏹').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('autoplay').setLabel('🔄').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('playlist').setLabel('📋').setStyle(ButtonStyle.Secondary),
    );

    queue.message.edit({ embeds: [embed], components: [row1, row2] }).catch(() => {});
  }
}

// ============================================================
// DISCORD CLIENT
// ============================================================
const manager = new MusicManager();
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

// ============================================================
// SLASH COMMANDS
// ============================================================
const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a song from YouTube')
    .addStringOption(opt => opt.setName('query').setDescription('Song name or YouTube URL').setRequired(true)),
  new SlashCommandBuilder().setName('skip').setDescription('Skip current song'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop music and clear queue'),
  new SlashCommandBuilder().setName('pause').setDescription('Pause playback'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume playback'),
  new SlashCommandBuilder().setName('queue').setDescription('Show current queue'),
  new SlashCommandBuilder().setName('nowplaying').setDescription('Show current song'),
  new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Set volume (0-100)')
    .addIntegerOption(opt => opt.setName('level').setDescription('Volume level 0-100').setRequired(true).setMinValue(0).setMaxValue(100)),
  new SlashCommandBuilder().setName('shuffle').setDescription('Toggle shuffle'),
  new SlashCommandBuilder().setName('loop').setDescription('Toggle loop (off/track/queue)'),
];

// Register commands
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    console.log('Registering slash commands...');
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands.map(c => c.toJSON()) });
    console.log('Commands registered!');
  } catch (error) {
    console.error('Command registration failed:', error);
  }
}

// ============================================================
// EVENT HANDLERS
// ============================================================
client.once('clientReady', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`🎵 Hikaru Music Bot is online!`);
  await registerCommands();
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isChatInputCommand()) {
    await handleCommand(interaction);
  } else if (interaction.isButton()) {
    await handleButton(interaction);
  }
});

async function handleCommand(interaction) {
  const { commandName, member, guild } = interaction;

  // Check if user is in voice channel
  const voiceChannel = member.voice.channel;
  if (!voiceChannel && commandName !== 'help') {
    return interaction.reply({ content: '❌ You need to be in a voice channel!', ephemeral: true });
  }

  switch (commandName) {
    case 'play': {
      await interaction.deferReply();
      const query = interaction.options.getString('query');

      try {
        // Search
        const results = await manager.search(query);
        if (!results.length) {
          return interaction.editReply('❌ No results found!');
        }

        const track = results[0];
        track.requestedBy = interaction.user.displayName;

        const queue = manager.getQueue(guild.id);
        queue.tracks.push(track);

        // Join voice channel
        if (!queue.connection || queue.connection.state.status === 'destroyed') {
          queue.connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
            debug: true,
          });

          queue.connection.on('debug', (msg) => console.log(`[Voice Debug] ${msg}`));
          queue.connection.on('error', (error) => console.error(`[Voice Error]`, error));

          try {
            await entersState(queue.connection, VoiceConnectionStatus.Ready, 20000);
          } catch (e) {
            queue.connection.destroy();
            return interaction.editReply('❌ Failed to join voice channel!');
          }
        }

        queue.channel = voiceChannel;

        // Send player embed
        const embed = new EmbedBuilder()
          .setColor(BLUE)
          .setTitle('🎵 MUSIC PANEL')
          .setDescription(`**Loading:** ${track.title}...`)
          .setTimestamp();

        const row1 = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('vol_down').setLabel('🔉').setStyle(ButtonStyle.Secondary).setDisabled(true),
          new ButtonBuilder().setCustomId('back').setLabel('⏮').setStyle(ButtonStyle.Secondary).setDisabled(true),
          new ButtonBuilder().setCustomId('pause').setLabel('⏸️').setStyle(ButtonStyle.Primary).setDisabled(true),
          new ButtonBuilder().setCustomId('skip').setLabel('⏭').setStyle(ButtonStyle.Secondary).setDisabled(true),
          new ButtonBuilder().setCustomId('vol_up').setLabel('🔊').setStyle(ButtonStyle.Secondary).setDisabled(true),
        );

        const row2 = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('shuffle').setLabel('🔀').setStyle(ButtonStyle.Secondary).setDisabled(true),
          new ButtonBuilder().setCustomId('loop').setLabel('🔁').setStyle(ButtonStyle.Secondary).setDisabled(true),
          new ButtonBuilder().setCustomId('stop').setLabel('⏹').setStyle(ButtonStyle.Danger).setDisabled(true),
          new ButtonBuilder().setCustomId('autoplay').setLabel('🔄').setStyle(ButtonStyle.Secondary).setDisabled(true),
          new ButtonBuilder().setCustomId('playlist').setLabel('📋').setStyle(ButtonStyle.Secondary).setDisabled(true),
        );

        const msg = await interaction.editReply({ embeds: [embed], components: [row1, row2] });
        queue.message = msg;

        // Start playing
        if (!queue.playing) {
          queue.currentIndex = queue.tracks.length - 1;
          manager.play(guild.id);
        } else {
          const formatTime = (s) => {
            const m = Math.floor(s / 60);
            const sec = Math.floor(s % 60);
            return `${m}:${sec.toString().padStart(2, '0')}`;
          };
          interaction.editReply({
            embeds: [new EmbedBuilder()
              .setColor(BLUE)
              .setTitle('📋 Added to Queue')
              .setDescription(`[${track.title}](${track.url})`)
              .addFields(
                { name: '👤 Requested by', value: track.requestedBy, inline: true },
                { name: '⏱️ Duration', value: formatTime(track.duration), inline: true },
                { name: '🎤 Author', value: track.uploader, inline: true },
              )
              .setFooter({ text: `Position in queue: ${queue.tracks.length}` })
              .setTimestamp()
            ]
          });
        }
      } catch (error) {
        console.error('Play error:', error);
        interaction.editReply(`❌ Error: ${error.message}`);
      }
      break;
    }

    case 'skip': {
      manager.skip(guild.id);
      interaction.reply('⏭️ Skipped!');
      break;
    }

    case 'stop': {
      manager.stop(guild.id);
      interaction.reply('⏹️ Stopped and cleared queue!');
      break;
    }

    case 'pause': {
      manager.pause(guild.id);
      interaction.reply('⏸️ Paused!');
      break;
    }

    case 'resume': {
      manager.resume(guild.id);
      interaction.reply('▶️ Resumed!');
      break;
    }

    case 'queue': {
      const queue = manager.getQueue(guild.id);
      if (queue.tracks.length === 0) {
        return interaction.reply('📋 Queue is empty!');
      }
      const formatTime = (s) => {
        const m = Math.floor(s / 60);
        const sec = Math.floor(s % 60);
        return `${m}:${sec.toString().padStart(2, '0')}`;
      };
      const list = queue.tracks.slice(0, 10).map((t, i) => {
        const prefix = i === queue.currentIndex ? '▶️' : `${i + 1}.`;
        return `${prefix} **${t.title}** (${formatTime(t.duration)})`;
      }).join('\n');
      interaction.reply({ embeds: [new EmbedBuilder().setColor(BLUE).setTitle('📋 Queue').setDescription(list).setFooter({ text: `${queue.tracks.length} tracks total` })] });
      break;
    }

    case 'nowplaying': {
      const queue = manager.getQueue(guild.id);
      if (!queue.playing || queue.currentIndex < 0) {
        return interaction.reply('❌ Nothing playing!');
      }
      const track = queue.tracks[queue.currentIndex];
      manager.updatePlayerEmbed(queue);
      interaction.reply({ content: '🎵 Now playing:', embeds: [interaction.message?.embeds?.[0] || new EmbedBuilder().setColor(BLUE).setDescription(`**${track.title}**`)], ephemeral: true });
      break;
    }

    case 'volume': {
      const level = interaction.options.getInteger('level');
      manager.setVolume(guild.id, level);
      interaction.reply(`🔊 Volume set to ${level}%`);
      break;
    }

    case 'shuffle': {
      manager.toggleShuffle(guild.id);
      const queue = manager.getQueue(guild.id);
      interaction.reply(`🔀 Shuffle ${queue.shuffle ? 'ON' : 'OFF'}`);
      break;
    }

    case 'loop': {
      manager.toggleLoop(guild.id);
      const queue = manager.getQueue(guild.id);
      interaction.reply(`🔁 Loop: ${queue.loop}`);
      break;
    }
  }
}

async function handleButton(interaction) {
  const { customId, guild } = interaction;
  const queue = manager.getQueue(guild.id);

  switch (customId) {
    case 'vol_down':
      manager.setVolume(guild.id, queue.volume - 10);
      interaction.deferUpdate();
      break;
    case 'vol_up':
      manager.setVolume(guild.id, queue.volume + 10);
      interaction.deferUpdate();
      break;
    case 'back':
      if (queue.currentIndex > 0) {
        queue.currentIndex -= 2;
        manager.skip(guild.id);
      }
      interaction.deferUpdate();
      break;
    case 'skip':
      manager.skip(guild.id);
      interaction.deferUpdate();
      break;
    case 'pause':
      if (queue.paused) {
        manager.resume(guild.id);
      } else {
        manager.pause(guild.id);
      }
      interaction.deferUpdate();
      break;
    case 'stop':
      manager.stop(guild.id);
      interaction.reply({ content: '⏹️ Stopped!', ephemeral: true });
      break;
    case 'shuffle':
      manager.toggleShuffle(guild.id);
      interaction.deferUpdate();
      break;
    case 'loop':
      manager.toggleLoop(guild.id);
      interaction.deferUpdate();
      break;
    case 'autoplay':
      queue.autoplay = !queue.autoplay;
      interaction.reply({ content: `🔄 Autoplay ${queue.autoplay ? 'ON' : 'OFF'}`, ephemeral: true });
      break;
    case 'playlist':
      const list = queue.tracks.slice(0, 10).map((t, i) => {
        const prefix = i === queue.currentIndex ? '▶️' : `${i + 1}.`;
        return `${prefix} ${t.title}`;
      }).join('\n');
      interaction.reply({ content: `📋 **Queue:**\n${list || 'Empty'}`, ephemeral: true });
      break;
  }
}

// ============================================================
// LOGIN
// ============================================================
client.login(TOKEN);
