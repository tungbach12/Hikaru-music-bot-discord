const { Client, GatewayIntentBits, REST, Routes, Partials, MessageFlags,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { joinVoiceChannel, VoiceConnectionStatus, entersState } = require('@discordjs/voice');
const { TOKEN, CLIENT_ID, BLUE } = require('./config');
const commands = require('./commands/index');
const MusicManager = require('./MusicManager');
const playlists = require('./playlists');
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

// ── Shared: enqueue tracks + join voice + play (used by /play and /playlist play) ──
// tracks: array of {id,title,url,duration,uploader,thumbnail, requestedBy?}

async function addTracksAndPlay(client, interaction, guild, voiceChannel, tracks, label) {
  if (!tracks.length) {
    await interaction.editReply('❌ No tracks to play!');
    setTimeout(() => interaction.deleteReply().catch(() => {}), 3000);
    return;
  }

  const queue = manager.getQueue(guild.id);

  for (const t of tracks) {
    if (!t.requestedBy) t.requestedBy = interaction.user.displayName;
    queue.tracks.push(t);
  }

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
  const savedJoin = loadState();
  savedJoin[guild.id] = { stay: queue.stay !== false, channelId: voiceChannel.id };
  saveState(savedJoin);

  const firstWasEmpty = !queue.playing;
  if (firstWasEmpty) {
    const panelEmbed = buildLoadingEmbed(tracks[0]);
    const panelMsg = await voiceChannel.guild.channels.cache.get(voiceChannel.id)?.send({
      embeds: [panelEmbed],
      components: [buildControlRow1(true), buildControlRow2(true)],
    });
    queue.message = panelMsg;
    queue.currentIndex = queue.tracks.length - tracks.length; // first of the new batch
    await interaction.editReply(`🎵 ${label || 'Playing'}!`);
    setTimeout(() => interaction.deleteReply().catch(() => {}), 2000);
    manager.play(guild.id);
  } else {
    if (queue.message) queue.message.delete().catch(() => {});
    const newPanel = await voiceChannel.guild.channels.cache.get(voiceChannel.id)?.send({
      embeds: [buildAddedEmbed(tracks[tracks.length - 1], queue)],
      components: [buildControlRow1(true), buildControlRow2(true)],
    });
    queue.message = newPanel;
    setTimeout(() => manager.updatePlayerEmbedFast(queue), 1000);
    await interaction.editReply(`📋 Added ${tracks.length} track(s) to queue!`);
    setTimeout(() => interaction.deleteReply().catch(() => {}), 2000);
  }
}

// ── Command handler ──────────────────────────────────────────

async function handleCommand(interaction) {
  const { commandName, member, guild } = interaction;
  const voiceChannel = member.voice.channel;

  if (!voiceChannel && commandName !== 'help' && commandName !== 'history' && commandName !== 'playlist') {
    return interaction.reply({ content: '❌ You need to be in a voice channel!', flags: MessageFlags.Ephemeral });
  }

  switch (commandName) {
    // ── /play ──────────────────────────────────────────────
    case 'play': {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const query = interaction.options.getString('query');
      try {
        // YouTube playlist URL → enqueue every song (the "go through many songs" fix)
        const isPlaylist = /^https?:\/\//.test(query)
          && /[?&]list=/.test(query)
          && /youtube\.com|youtu\.be/i.test(query);
        if (isPlaylist) {
          const all = await manager.getPlaylistTracks(query);
          if (!all.length) {
            await interaction.editReply('❌ No tracks found in that playlist!');
            setTimeout(() => interaction.deleteReply().catch(() => {}), 3000);
            return;
          }
          await addTracksAndPlay(client, interaction, guild, voiceChannel, all, `Playing ${all.length} songs`);
          break;
        }
        const results = await manager.search(query);
        if (!results.length) {
          await interaction.editReply('❌ No results found!');
          setTimeout(() => interaction.deleteReply().catch(() => {}), 3000);
          return;
        }
        const track = results[0];
        track.requestedBy = interaction.user.displayName;
        await addTracksAndPlay(client, interaction, guild, voiceChannel, [track], 'Playing');
      } catch (error) {
        console.error('Play error:', error);
        await interaction.editReply(`❌ Error: ${error.message}`);
        setTimeout(() => interaction.deleteReply().catch(() => {}), 5000);
      }
      break;
    }

    // ── /history ───────────────────────────────────────────
    case 'history': {
      const hist = playlists.getHistory(guild.id, 25);
      if (!hist.length) {
        return interaction.reply({ content: '📭 No history yet — play some songs first!', flags: MessageFlags.Ephemeral });
      }
      const menu = new StringSelectMenuBuilder()
        .setCustomId('history_select')
        .setMinValues(1)
        .setMaxValues(Math.min(hist.length, 25))
        .setPlaceholder('Select songs to save into a playlist…')
        .addOptions(hist.slice(0, 25).map((t, i) => ({
          label: (t.title || 'Unknown').slice(0, 100),
          description: ((t.uploader || '') || `Song ${i + 1}`).slice(0, 100),
          value: `h|${t.id || t.url}`,
        })));
      const saveBtn = new ButtonBuilder().setCustomId('playlist_save_yes').setLabel('💾 Save').setStyle(ButtonStyle.Primary);
      const cancelBtn = new ButtonBuilder().setCustomId('playlist_save_no').setLabel('Cancel').setStyle(ButtonStyle.Secondary);
      const embed = new EmbedBuilder().setColor(BLUE)
        .setTitle('🕘 Recently Played')
        .setDescription(`Select one or more songs, then click **Save** to name your playlist.\nShowing ${hist.length} of ${playlists.getHistoryCount(guild.id)}.`);
      await interaction.reply({
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(menu), new ActionRowBuilder().addComponents(saveBtn, cancelBtn)],
        flags: MessageFlags.Ephemeral,
      });
      break;
    }

    // ── /playlist ──────────────────────────────────────────
    case 'playlist': {
      const sub = interaction.options.getSubcommand();
      if (sub === 'play') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const name = interaction.options.getString('name');
        const pl = playlists.getPlaylist(guild.id, name);
        if (!pl || !pl.tracks.length) {
          await interaction.editReply(`❌ Playlist "${name}" is empty or not found.`);
          setTimeout(() => interaction.deleteReply().catch(() => {}), 4000);
          return;
        }
        await addTracksAndPlay(client, interaction, guild, voiceChannel, pl.tracks.map(t => ({ ...t })), `Playing "${name}"`);
      } else if (sub === 'list') {
        const names = playlists.getPlaylistNames(guild.id);
        if (!names.length) {
          return interaction.reply({ content: '📂 No saved playlists yet. Use `/history` → Save, or `/playlist save`.', flags: MessageFlags.Ephemeral });
        }
        const embed = new EmbedBuilder().setColor(BLUE).setTitle('📂 Your Playlists')
          .setDescription(names.map((n, i) => `${i + 1}. **${n}**`).join('\n'));
        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      } else if (sub === 'show') {
        const name = interaction.options.getString('name');
        const pl = playlists.getPlaylist(guild.id, name);
        if (!pl) return interaction.reply({ content: `❌ Playlist "${name}" not found.`, flags: MessageFlags.Ephemeral });
        const lines = pl.tracks.slice(0, 25).map((t, i) => `${i + 1}. ${t.title}`).join('\n') || '(empty)';
        const embed = new EmbedBuilder().setColor(BLUE).setTitle(`📃 ${pl.name}`)
          .setDescription(`${pl.tracks.length} songs:\n${lines}`);
        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      } else if (sub === 'save') {
        const name = playlists.sanitizeName(interaction.options.getString('name'));
        const queue = manager.getQueue(guild.id);
        if (!name) return interaction.reply({ content: '❌ Invalid playlist name.', flags: MessageFlags.Ephemeral });
        const tracks = queue.tracks.map(t => ({ ...t }));
        if (!tracks.length) return interaction.reply({ content: '❌ Queue is empty — nothing to save.', flags: MessageFlags.Ephemeral });
        playlists.savePlaylist(guild.id, name, tracks);
        // Offer to play it now
        const playBtn = new ButtonBuilder().setCustomId(`playlist:play:${name}`).setLabel('▶ Play now').setStyle(ButtonStyle.Success);
        const embed = new EmbedBuilder().setColor(BLUE).setTitle('💾 Playlist saved')
          .setDescription(`**${name}** — ${tracks.length} songs saved from the current queue.`);
        await interaction.reply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(playBtn)], flags: MessageFlags.Ephemeral });
      } else if (sub === 'delete') {
        const name = interaction.options.getString('name');
        const ok = playlists.deletePlaylist(guild.id, name);
        if (ok) return interaction.reply({ content: `🗑 Deleted playlist **${name}**.`, flags: MessageFlags.Ephemeral });
        return interaction.reply({ content: `❌ Playlist "${name}" not found.`, flags: MessageFlags.Ephemeral });
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
      savedState[guild.id] = { stay: stayOn, channelId: queue?.channel?.id || null };
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

  // Playlist "play now" button from /playlist save
  if (customId.startsWith('playlist:play:')) {
    const name = customId.slice('playlist:play:'.length);
    const pl = playlists.getPlaylist(guild.id, name);
    if (!pl || !pl.tracks.length) return interaction.reply({ content: `❌ Playlist "${name}" not found.`, flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const voiceChannel = interaction.member.voice.channel;
    if (!voiceChannel) {
      await interaction.editReply('❌ You need to be in a voice channel!');
      setTimeout(() => interaction.deleteReply().catch(() => {}), 3000);
      return;
    }
    await addTracksAndPlay(client, interaction, guild, voiceChannel, pl.tracks.map(t => ({ ...t })), `Playing "${name}"`);
    return;
  }

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
        const saved2 = loadState();
        saved2[guild.id] = { stay: queue.stay, channelId: queue.channel?.id || null };
        saveState(saved2);
        break;
      case 'playlist_save_yes': {
        // Re-open as a modal asking for the playlist name. We stash the
        // selected track ids in the modal customId (passed from the select menu
        // via the interaction's message components is not possible, so the ids
        // were captured when the select fired — but here we only get the button).
        // Instead the flow: select menu → stores ids in a pending map.
        const pending = pendingSaves.get(interaction.user.id);
        if (!pending || !pending.length) {
          return interaction.reply({ content: '⚠️ Selection expired. Re-open `/history` and select again.', flags: MessageFlags.Ephemeral });
        }
        const modal = new ModalBuilder()
          .setCustomId(`playlist_save_modal|${pending.join(',')}`)
          .setTitle('Save playlist');
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('playlist_name')
            .setLabel(`Name (${pending.length} songs)`)
            .setStyle(TextInputStyle.Short).setMaxLength(60).setRequired(true)
        ));
        await interaction.showModal(modal);
        break;
      }
      case 'playlist_save_no':
        await interaction.update({ content: '❌ Cancelled.', components: [], embeds: [] });
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
    await interaction.deferUpdate().catch(() => {});
  } catch (error) {
    console.error('Button error:', error);
    interaction.reply({ content: `⚠️ Lỗi: ${error.message || 'unknown'}`, flags: MessageFlags.Ephemeral })
      .catch(() => interaction.deferUpdate().catch(() => {}));
  }
}

// Pending history selections per user (until they click Save)
const pendingSaves = new Map();

async function handleSelectMenu(interaction) {
  const { customId, values, user, guild } = interaction;
  if (customId === 'history_select') {
    const ids = values.map(v => v.startsWith('h|') ? v.slice(2) : v);
    pendingSaves.set(user.id, ids);
    await interaction.reply({
      content: `✅ Selected **${ids.length}** song(s). Click **Save** below to name your playlist.`,
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('playlist_save_yes').setLabel('💾 Save').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('playlist_save_no').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
      )],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  console.warn(`[select] Unknown customId: ${customId}`);
}

async function handleModalSubmit(interaction) {
  const { customId, fields, user, guild } = interaction;
  if (customId.startsWith('playlist_save_modal')) {
    const ids = customId.slice('playlist_save_modal|'.length).split(',').filter(Boolean);
    const name = playlists.sanitizeName(fields.getTextInputValue('playlist_name'));
    if (!name) return interaction.reply({ content: '❌ Invalid playlist name.', flags: MessageFlags.Ephemeral });
    const hist = playlists.getHistory(guild.id, playlists.HISTORY_LIMIT);
    const chosen = ids.map(id => hist.find(t => (t.id || t.url) === id)).filter(Boolean).map(t => ({ ...t }));
    if (!chosen.length) return interaction.reply({ content: '⚠️ Selected songs no longer in history.', flags: MessageFlags.Ephemeral });
    playlists.savePlaylist(guild.id, name, chosen);
    pendingSaves.delete(user.id);
    const playBtn = new ButtonBuilder().setCustomId(`playlist:play:${name}`).setLabel('▶ Play now').setStyle(ButtonStyle.Success);
    await interaction.reply({
      embeds: [new EmbedBuilder().setColor(BLUE).setTitle('💾 Playlist saved')
        .setDescription(`**${name}** — ${chosen.length} songs saved.`)],
      components: [new ActionRowBuilder().addComponents(playBtn)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  console.warn(`[modal] Unknown customId: ${customId}`);
}

async function handleAutocomplete(interaction) {
  const { commandName, options } = interaction;
  if (commandName === 'playlist') {
    const focused = options.getFocused(true);
    if (focused.name === 'name') {
      const names = playlists.getPlaylistNames(interaction.guild.id)
        .filter(n => n.toLowerCase().includes((focused.value || '').toLowerCase()))
        .slice(0, 25)
        .map(n => ({ name: n, value: n }));
      await interaction.respond(names);
      return;
    }
  }
  await interaction.respond([]);
}

// ── Events ───────────────────────────────────────────────────

client.once('clientReady', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`🎵 Hikaru Music Bot is online!`);
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
    else if (interaction.isStringSelectMenu()) await handleSelectMenu(interaction);
    else if (interaction.isModalSubmit()) await handleModalSubmit(interaction);
    else if (interaction.isAutocomplete()) await handleAutocomplete(interaction);
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

  if (oldState.channelId !== newState.channelId) {
    if (newState.id === client.user.id) {
      queue.channel = newState.channel;
      if (queue.stay && newState.channelId) {
        const sv = loadState();
        if (sv[guildId]) { sv[guildId].channelId = newState.channelId; saveState(sv); }
      }
    }
  }

  if (oldState.channelId && oldState.channelId === queue.channel?.id) {
    const channel = oldState.guild.channels.cache.get(oldState.channelId);
    if (!channel) return;
    const humans = channel.members.filter(m => !m.user.bot).size;
    if (humans === 0 && !queue.stay && !queue.playing) {
      console.log(`[VoiceState] Channel empty, scheduling disconnect in ${DISCONNECT_TIMEOUT_MS / 1000}s`);
      scheduleDisconnect(client, guildId);
    }
  }

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
