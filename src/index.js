const { Client, GatewayIntentBits, REST, Routes, Partials, MessageFlags } = require('discord.js');
const { joinVoiceChannel, VoiceConnectionStatus, entersState } = require('@discordjs/voice');
const { TOKEN, CLIENT_ID, BLUE } = require('./config');
const commands = require('./commands/index');
const MusicManager = require('./MusicManager');
const { loadState, saveState } = require('./state');
const {
  formatTime, buildPlayingEmbed, buildLoadingEmbed, buildAddedEmbed,
  buildQueueEmbed, buildControlRow1, buildControlRow2,
} = require('./PlayerUI');

const manager = new MusicManager();
const DISCONNECT_TIMEOUT_MS = 30_000; // 30 seconds before leaving empty channel
const disconnectTimers = new Map(); // guildId -> setTimeout

function scheduleDisconnect(client, guildId) {
  if (disconnectTimers.has(guildId)) return;
  const queue = manager.queues.get(guildId);
  // Stay ON → never schedule a disconnect. User: "stay instead of disconnect."
  if (!queue || queue.stay) return;
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
    return interaction.reply({ content: '❌ You need to be in a voice channel!', flags: MessageFlags.Ephemeral });
  }

  switch (commandName) {
    // ── /play ──────────────────────────────────────────────
    case 'play': {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const query = interaction.options.getString('query');

      try {
        const results = await manager.search(query);
        if (!results.length) {
          await interaction.editReply('❌ No results found!');
          setTimeout(() => interaction.deleteReply().catch(() => {}), 3000);
          return;
        }

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
            selfDeaf: true,
          });
          try {
            await entersState(queue.connection, VoiceConnectionStatus.Ready, 20000);
          } catch {
            queue.connection.destroy();
            await interaction.editReply('❌ Failed to join voice channel!');
            setTimeout(() => interaction.deleteReply().catch(() => {}), 3000);
            return;
          }
        }

        queue.channel = voiceChannel;
        queue.onIdle = (gid) => scheduleDisconnect(client, gid);
        // Persist channelId so a Stay ON bot can re-join after restart.
        // ALWAYS create/write the entry (state.json may be empty on first use).
        const savedJoin = loadState();
        savedJoin[guild.id] = {
          stay: queue.stay !== false,            // keep explicit OFF, else default ON
          channelId: voiceChannel.id,
        };
        saveState(savedJoin);

        if (!queue.playing) {
          // First track — send MUSIC PANEL as channel message (not interaction reply)
          const panelEmbed = buildLoadingEmbed(track);
          const panelMsg = await voiceChannel.guild.channels.cache.get(voiceChannel.id)?.send({
            embeds: [panelEmbed],
            components: [buildControlRow1(true), buildControlRow2(true)],
          });
          queue.message = panelMsg;
          queue.currentIndex = queue.tracks.length - 1;
          // Delete interaction reply
          await interaction.editReply('🎵 Playing!');
          setTimeout(() => interaction.deleteReply().catch(() => {}), 2000);
          manager.play(guild.id);
        } else {
          // Already playing — delete old panel, send new one at bottom
          if (queue.message) {
            queue.message.delete().catch(() => {});
          }
          const newPanel = await voiceChannel.guild.channels.cache.get(voiceChannel.id)?.send({
            embeds: [buildAddedEmbed(track, queue)],
            components: [buildControlRow1(true), buildControlRow2(true)],
          });
          queue.message = newPanel;
          // Update to playing state after short delay
          setTimeout(() => manager.updatePlayerEmbedFast(queue), 1000);
          await interaction.editReply('📋 Added to queue!');
          setTimeout(() => interaction.deleteReply().catch(() => {}), 2000);
        }
      } catch (error) {
        console.error('Play error:', error);
        await interaction.editReply(`❌ Error: ${error.message}`);
        setTimeout(() => interaction.deleteReply().catch(() => {}), 5000);
      }
      break;
    }

    case 'skip':
      manager.skip(guild.id);
      interaction.reply('⏭️ Skipped!');
      break;

    case 'stop': {
      const r = await manager.stop(guild.id);
      interaction.reply(r && !r.left
        ? (r.message || '⏹ Queue cleared — bot stays (Stay ON). Press Stop again to leave.')
        : '⏹️ Stopped and cleared queue!');
      break;
    }

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
      interaction.reply({ content: '🎵 Now playing:', flags: MessageFlags.Ephemeral });
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
      const savedState = loadState();
      savedState[guild.id] = { stay: stayOn, channelId: queue.channel?.id || null };
      saveState(savedState);
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

  try {
    switch (customId) {
      case 'vol_down':
        manager.setVolume(guild.id, queue.volume - 10);
        manager.updatePlayerEmbedFast(queue);
        break;
      case 'vol_up':
        manager.setVolume(guild.id, queue.volume + 10);
        manager.updatePlayerEmbedFast(queue);
        break;
      case 'back': {
        const r = await manager.back(guild.id);
        if (r && !r.ok) return interaction.reply({ content: r.message, flags: MessageFlags.Ephemeral });
        break;
      }
      case 'skip': {
        const r = await manager.skip(guild.id);
        if (!r.ok) return interaction.reply({ content: r.message, flags: MessageFlags.Ephemeral });
        break;
      }
      case 'pause':
        queue.paused ? manager.resume(guild.id) : manager.pause(guild.id);
        manager.updatePlayerEmbedFast(queue);
        break;
      case 'stop': {
        const r = await manager.stop(guild.id);
        if (r && !r.left) {
          // Stay ON — queue cleared but bot remains. Tell the user.
          return interaction.reply({ content: r.message || '⏹ Queue cleared — bot stays.', flags: MessageFlags.Ephemeral });
        }
        break;
      }
      case 'shuffle':
        manager.toggleShuffle(guild.id);
        manager.updatePlayerEmbedFast(queue);
        break;
      case 'loop':
        manager.toggleLoop(guild.id);
        manager.updatePlayerEmbedFast(queue);
        break;
      case 'stay':
        manager.toggleStay(guild.id);
        manager.updatePlayerEmbedFast(queue);
        // Persist stay state (survives PM2 restarts)
        const saved2 = loadState();
        saved2[guild.id] = { stay: queue.stay, channelId: queue.channel?.id || null };
        saveState(saved2);
        break;
      case 'playlist': {
        const list = queue.tracks.slice(0, 10).map((t, i) => {
          const prefix = i === queue.currentIndex ? '▶️' : `${i + 1}.`;
          return `${prefix} ${t.title}`;
        }).join('\n');
        return interaction.reply({ content: `📋 **Queue:**\n${list || 'Empty'}`, flags: MessageFlags.Ephemeral });
      }
      default:
        console.warn(`[button] Unknown customId: ${customId}`);
    }
    // Silent update — no message, just acknowledge the interaction
    await interaction.deferUpdate().catch(() => {});
  } catch (error) {
    console.error('Button error:', error);
    // Never leave the interaction hanging — reply with the error
    interaction.reply({ content: `⚠️ Lỗi: ${error.message || 'unknown'}`, flags: MessageFlags.Ephemeral })
      .catch(() => interaction.deferUpdate().catch(() => {}));
  }
}

// ── Events ───────────────────────────────────────────────────

client.once('clientReady', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`🎵 Hikaru Music Bot is online!`);
  // Stay state auto-restored per-guild via getQueue() in MusicManager.
  // Re-join voice channels that had Stay ON before the restart.
  const saved = loadState();
  const gids = Object.keys(saved).filter(g => saved[g]?.stay === false);
  if (gids.length) console.log(`[state] ${gids.length} guild(s) with Stay OFF restored`);
  const rejoined = await manager.rejoinSavedChannel(client, saved);
  if (rejoined > 0) console.log(`[state] Re-joined ${rejoined} voice channel(s) (Stay ON)`);
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
      // Bot moved — update channel reference + persist new channelId
      queue.channel = newState.channel;
      if (queue.stay && newState.channelId) {
        const sv = loadState();
        if (sv[guildId]) { sv[guildId].channelId = newState.channelId; saveState(sv); }
      }
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
