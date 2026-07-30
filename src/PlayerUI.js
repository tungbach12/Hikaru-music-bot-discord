const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { BLUE } = require('./config');

function formatTime(s) {
  if (!s) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function buildProgressBar(elapsed, duration) {
  if (!duration) return '';
  const len = 20;
  const pos = Math.min(Math.floor((elapsed / duration) * len), len);
  const bar = '─'.repeat(pos) + '🔵' + '─'.repeat(len - pos);
  return `${formatTime(elapsed)} ${bar} ${formatTime(duration)}`;
}

function buildPlayingEmbed(track, queue) {
  const loopEmoji = queue.loop === 'track' ? '🔂' : queue.loop === 'queue' ? '🔁' : '➡️';
  const stayEmoji = queue.stay ? '🔒 Stay' : '🔓 Auto-Leave';
  const progress = buildProgressBar(queue.elapsed || 0, track.duration || 0);
  return new EmbedBuilder()
    .setColor(BLUE)
    .setTitle('🎵 MUSIC PANEL')
    .setDescription(`**Now Playing:**\n[${track.title}](${track.url})` + (progress ? `\n\n${progress}` : ''))
    .addFields(
      { name: '👤 Requested by', value: track.requestedBy || 'Unknown', inline: true },
      { name: '⏱️ Duration', value: formatTime(track.duration), inline: true },
      { name: '🎤 Author', value: track.uploader || 'Unknown', inline: true },
    )
    .setThumbnail(track.thumbnail)
    .setFooter({
      text: `Queue: ${queue.currentIndex + 1}/${queue.tracks.length} | Volume: ${queue.volume}% | ${loopEmoji} Loop: ${queue.loop} | ${stayEmoji}`,
    })
    .setTimestamp();
}

function buildLoadingEmbed(track) {
  return new EmbedBuilder()
    .setColor(BLUE)
    .setTitle('🎵 MUSIC PANEL')
    .setDescription(`**Loading:** ${track.title}...`)
    .setTimestamp();
}

function buildAddedEmbed(track, queue) {
  return new EmbedBuilder()
    .setColor(BLUE)
    .setTitle('📋 Added to Queue')
    .setDescription(`[${track.title}](${track.url})`)
    .addFields(
      { name: '👤 Requested by', value: track.requestedBy, inline: true },
      { name: '⏱️ Duration', value: formatTime(track.duration), inline: true },
      { name: '🎤 Author', value: track.uploader, inline: true },
    )
    .setFooter({ text: `Position in queue: ${queue.tracks.length}` })
    .setTimestamp();
}

function buildQueueEmbed(queue) {
  const list = queue.tracks.slice(0, 10).map((t, i) => {
    const prefix = i === queue.currentIndex ? '▶️' : `${i + 1}.`;
    return `${prefix} **${t.title}** (${formatTime(t.duration)})`;
  }).join('\n');
  return new EmbedBuilder()
    .setColor(BLUE)
    .setTitle('📋 Queue')
    .setDescription(list || 'Queue is empty')
    .setFooter({ text: `${queue.tracks.length} tracks total` });
}

function buildControlRow1(disabled = false, paused = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('seek_back').setLabel('⏪').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    new ButtonBuilder().setCustomId('back').setLabel('⏮').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    new ButtonBuilder().setCustomId('pause').setLabel(paused ? '▶️' : '⏸️').setStyle(ButtonStyle.Primary).setDisabled(disabled),
    new ButtonBuilder().setCustomId('skip').setLabel('⏭').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    new ButtonBuilder().setCustomId('seek_fwd').setLabel('⏩').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
  );
}

function buildControlRow2(disabled = false, shuffle = false, loopOff = true, stayOff = true) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('shuffle').setLabel('🔀').setStyle(shuffle ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(disabled),
    new ButtonBuilder().setCustomId('loop').setLabel('🔁').setStyle(loopOff ? ButtonStyle.Secondary : ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId('stop').setLabel('⏹').setStyle(ButtonStyle.Danger).setDisabled(disabled),
    new ButtonBuilder().setCustomId('stay').setLabel(stayOff ? '🔓' : '🔒').setStyle(stayOff ? ButtonStyle.Secondary : ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId('playlist').setLabel('📋').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
  );
}

module.exports = {
  formatTime,
  buildPlayingEmbed,
  buildLoadingEmbed,
  buildAddedEmbed,
  buildQueueEmbed,
  buildControlRow1,
  buildControlRow2,
};
