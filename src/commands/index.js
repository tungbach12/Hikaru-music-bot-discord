const { SlashCommandBuilder } = require('discord.js');

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
];

module.exports = commands;
