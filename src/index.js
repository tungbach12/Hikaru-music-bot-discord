const { Client, GatewayIntentBits, REST, Routes, Partials } = require('discord.js');
const { joinVoiceChannel, VoiceConnectionStatus, entersState } = require('@discordjs/voice');
const { TOKEN, CLIENT_ID, BLUE } = require('./config');
const commands = require('./commands/index');
const MusicManager = require('./MusicManager');
const {
  formatTime, buildPlayingEmbed, buildLoadingEmbed, buildAddedEmbed,
  buildQueueEmbed, buildControlRow1, buildControlRow2,
} = require('./PlayerUI');

const manager = new MusicManager();
const DISCONNECT_TIMEOUT_MS = 30_000; // 30 seconds before leaving empty channel
const disconnectTimers = new Map(); // guildId -> setTimeout

function scheduleDisconnect(client, guildId) {
  if (disconnectTimers.has(guildId)) return;
  const timer = setTimeout(async () => {
    disconnectTimers.delete(guildId);
    const queue = manager.queues.get(guildId);
    if (!queue || queue.stay || queue.playing) return;
    // Check again: if still empty, disconnect
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;
    const vc = guild.channels.cache.get(queue.channel?.id);
    const botMember = guild.members.cache.get(client.user.id);
    if (vc && botMember && vc.members.filter(m => !m.user.bot).size === 0) {
      console.log(`[Disconnect] ${guildId} — channel empty for ${DISCONNECT_TIMEOUT_MS / 1000}s`);
      await manager.stop(guildId);
    }
  }, DISCONNECT_TIMEOUT_MS);
  disconnectTimers.set(guildId, timer);
}

function cancelDisconnect(guildId) {
  if (disconnectTimers.has(guildId)) {
    clearTimeout(disconnectTimers.get(guildId));
    disconnectTimers.delete(guildId);
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

// ── Register slash commands ──────────────────────────────────

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

// ── Command handler ──────────────────────────────────────────

async function handleCommand(interaction) {
  const { commandName, member, guild } = interaction;
  const voiceChannel = member.voice.channel;

  if (!voiceChannel && commandName !== 'help') {
    return interaction.reply({ content: '❌ You need to be in a voice channel!', ephemeral: true });
  }

  switch (commandName) {
    // ── /play ──────────────────────────────────────────────
    case 'play': {
      await interaction.deferReply();
      const query = interaction.options.getString('query');

      try {
        const results = await manager.search(query);
        if (!results.length) return interaction.editReply('❌ No results found!');

        const track = results[0];
        track.requestedBy = interaction.user.displayName;

        const queue = manager.getQueue(guild.id);
        queue.tracks.push(track);

        // Join voice
        if (!queue.connection || queue.connection.state.status === 'destroyed') {
          queue.connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
          });
          try {
            await entersState(queue.connection, VoiceConnectionStatus.Ready, 20000);
          } catch {
            queue.connection.destroy();
            return interaction.editReply('❌ Failed to join voice channel!');
          }
        }

        queue.channel = voiceChannel;
        // Set callback for when queue ends (triggers disconnect timer)
        queue.onIdle = (gid) => scheduleDisconnect(client, gid);

        if (!queue.playing) {
          // First track — send loading embed, then play
          const msg = await interaction.editReply({
            embeds: [buildLoadingEmbed(track)],
            components: [buildControlRow1(true), buildControlRow2(true)],
          });
          queue.message = msg;
          queue.currentIndex = queue.tracks.length - 1;
          manager.play(guild.id);
        } else {
          // Already playing — show "added to queue"
          interaction.editReply({ embeds: [buildAddedEmbed(track, queue)] });
        }
      } catch (error) {
        console.error('Play error:', error);
        interaction.editReply(`❌ Error: ${error.message}`);
      }
      break;
    }

    case 'skip':
      manager.skip(guild.id);
      interaction.reply('⏭️ Skipped!');
      break;

    case 'stop':
      manager.stop(guild.id);
      interaction.reply('⏹️ Stopped and cleared queue!');
      break;

    case 'pause':
      manager.pause(guild.id);
      interaction.reply('⏸️ Paused!');
      break;

    case 'resume':
      manager.resume(guild.id);
      interaction.reply('▶️ Resumed!');
      break;

    case 'queue': {
      const queue = manager.getQueue(guild.id);
      interaction.reply({ embeds: [buildQueueEmbed(queue)] });
      break;
    }

    case 'nowplaying': {
      const queue = manager.getQueue(guild.id);
      if (!queue.playing || queue.currentIndex < 0) {
        return interaction.reply('❌ Nothing playing!');
      }
      manager.updatePlayerEmbed(queue);
      interaction.reply({ content: '🎵 Now playing:', ephemeral: true });
      break;
    }

    case 'volume': {
      const level = interaction.options.getInteger('level');
      manager.setVolume(guild.id, level);
      interaction.reply(`🔊 Volume set to ${level}%`);
      break;
    }

    case 'shuffle':
      manager.toggleShuffle(guild.id);
      interaction.reply(`🔀 Shuffle ${manager.getQueue(guild.id).shuffle ? 'ON' : 'OFF'}`);
      break;

    case 'loop':
      manager.toggleLoop(guild.id);
      interaction.reply(`🔁 Loop: ${manager.getQueue(guild.id).loop}`);
      break;

    case 'stay': {
      const stayOn = manager.toggleStay(guild.id);
      interaction.reply(stayOn
        ? '🔒 Stay ON — bot stays in voice channel indefinitely'
        : '🔓 Stay OFF — bot leaves when channel is empty or queue ends');
      break;
    }
  }
}

// ── Button handler ───────────────────────────────────────────

async function handleButton(interaction) {
  const { customId, guild } = interaction;
  const queue = manager.getQueue(guild.id);

  switch (customId) {
    case 'vol_down':
      manager.setVolume(guild.id, queue.volume - 10);
      break;
    case 'vol_up':
      manager.setVolume(guild.id, queue.volume + 10);
      break;
    case 'back':
      manager.back(guild.id);
      break;
    case 'skip':
      manager.skip(guild.id);
      break;
    case 'pause':
      queue.paused ? manager.resume(guild.id) : manager.pause(guild.id);
      break;
    case 'stop':
      manager.stop(guild.id);
      return interaction.reply({ content: '⏹️ Stopped!', ephemeral: true });
    case 'shuffle':
      manager.toggleShuffle(guild.id);
      break;
    case 'loop':
      manager.toggleLoop(guild.id);
      break;
    case 'stay': {
      const stayOn = manager.toggleStay(guild.id);
      return interaction.reply({ content: stayOn ? '🔒 Stay ON' : '🔓 Stay OFF', ephemeral: true });
    }
    case 'playlist': {
      const list = queue.tracks.slice(0, 10).map((t, i) => {
        const prefix = i === queue.currentIndex ? '▶️' : `${i + 1}.`;
        return `${prefix} ${t.title}`;
      }).join('\n');
      return interaction.reply({ content: `📋 **Queue:**\n${list || 'Empty'}`, ephemeral: true });
    }
  }
  interaction.deferUpdate();
}

// ── Events ───────────────────────────────────────────────────

client.once('clientReady', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`🎵 Hikaru Music Bot is online!`);
  await registerCommands();
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) await handleCommand(interaction);
    else if (interaction.isButton()) await handleButton(interaction);
  } catch (error) {
    console.error('Interaction error:', error);
  }
});

// ── Voice state: detect empty channel → auto-disconnect ──────

client.on('voiceStateUpdate', (oldState, newState) => {
  const guildId = oldState.guild?.id || newState.guild?.id;
  if (!guildId) return;
  const queue = manager.queues.get(guildId);
  if (!queue) return;

  // Bot was moved to another channel
  if (oldState.channelId !== newState.channelId) {
    if (newState.id === client.user.id) {
      // Bot moved — update channel reference
      queue.channel = newState.channel;
    }
  }

  // Someone left a channel the bot is in
  if (oldState.channelId && oldState.channelId === queue.channel?.id) {
    const channel = oldState.guild.channels.cache.get(oldState.channelId);
    if (!channel) return;
    const humans = channel.members.filter(m => !m.user.bot).size;
    if (humans === 0 && !queue.stay && !queue.playing) {
      console.log(`[VoiceState] Channel empty, scheduling disconnect in ${DISCONNECT_TIMEOUT_MS / 1000}s`);
      scheduleDisconnect(client, guildId);
    }
  }

  // Someone joined — cancel pending disconnect
  if (newState.channelId && newState.channelId === queue.channel?.id) {
    if (newState.id !== client.user.id) {
      cancelDisconnect(guildId);
    }
  }
});

// ── Graceful shutdown ────────────────────────────────────────

async function shutdown() {
  console.log('Shutting down...');
  for (const [guildId] of manager.queues) {
    await manager.stop(guildId);
  }
  client.destroy();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ── Start ────────────────────────────────────────────────────

client.login(TOKEN);
