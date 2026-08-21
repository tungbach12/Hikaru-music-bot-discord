const { SlashCommandBuilder, PermissionsBitField, ApplicationCommandOptionChoiceData } = require('discord.js');

/**
 * All slash command definitions.
 * To add a new command: add the builder here + handler in handleCommand.
 */
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
  new SlashCommandBuilder().setName('stay').setDescription('Toggle stay in voice channel after queue ends'),

  // ── /history — show recently played songs (select menu opens to save) ──
  new SlashCommandBuilder()
    .setName('history')
    .setDescription('Show songs you played (select to build a playlist)'),

  // ── /playlist — manage saved playlists ──
  new SlashCommandBuilder()
    .setName('playlist')
    .setDescription('Manage your saved playlists')
    .addSubcommand(sub => sub
      .setName('play')
      .setDescription('Play a saved playlist')
      .addStringOption(opt => opt.setName('name').setDescription('Playlist name').setRequired(true).setAutocomplete(true)))
    .addSubcommand(sub => sub
      .setName('list')
      .setDescription('List your saved playlists'))
    .addSubcommand(sub => sub
      .setName('show')
      .setDescription('Show the songs in a saved playlist')
      .addStringOption(opt => opt.setName('name').setDescription('Playlist name').setRequired(true).setAutocomplete(true)))
    .addSubcommand(sub => sub
      .setName('save')
      .setDescription('Save the current queue as a playlist')
      .addStringOption(opt => opt.setName('name').setDescription('Playlist name').setRequired(true)))
    .addSubcommand(sub => sub
      .setName('delete')
      .setDescription('Delete a saved playlist')
      .addStringOption(opt => opt.setName('name').setDescription('Playlist name').setRequired(true).setAutocomplete(true))),
];

module.exports = commands;
