#!/usr/bin/env node
/**
 * Hikaru Music Bot — Test Suite
 * Runs syntax checks, module loading, and logic verification.
 * Usage: node test.js
 */

const { execSync } = require('child_process');
const path = require('path');

const SRC = path.join(__dirname, 'src');
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name}: ${e.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

// ══════════════════════════════════════════════════════════════
// 1. Syntax checks
// ══════════════════════════════════════════════════════════════
console.log('\n🔍 Syntax checks');
const files = ['config.js', 'stream.js', 'PlayerUI.js', 'MusicManager.js', 'index.js', 'commands/index.js'];
for (const f of files) {
  test(`syntax: ${f}`, () => {
    try {
      execSync(`node --check ${path.join(SRC, f)}`, { stdio: 'pipe' });
    } catch (e) {
      throw new Error(e.stderr?.toString() || 'syntax error');
    }
  });
}

// ══════════════════════════════════════════════════════════════
// 2. Module loading
// ══════════════════════════════════════════════════════════════
console.log('\n📦 Module loading');
let config, stream, PlayerUI, MusicManager, commands;
test('load: config.js', () => { config = require('./src/config'); });
test('load: stream.js', () => { stream = require('./src/stream'); });
test('load: PlayerUI.js', () => { PlayerUI = require('./src/PlayerUI'); });
test('load: MusicManager.js', () => { MusicManager = require('./src/MusicManager'); });
test('load: commands/index.js', () => { commands = require('./src/commands/index'); });

// ══════════════════════════════════════════════════════════════
// 3. Config validation
// ══════════════════════════════════════════════════════════════
console.log('\n⚙️ Config');
test('config.TOKEN exists', () => assert(typeof config.TOKEN === 'string' && config.TOKEN.length > 0, 'TOKEN missing'));
test('config.CLIENT_ID exists', () => assert(typeof config.CLIENT_ID === 'string' && config.CLIENT_ID.length > 0, 'CLIENT_ID missing'));
test('config.WARP_PROXY default', () => assert(config.WARP_PROXY.includes('socks5'), 'WARP_PROXY wrong'));
test('config.BLUE is number', () => assert(typeof config.BLUE === 'number', 'BLUE wrong'));
test('config.DEFAULT_VOLUME is 80', () => assert(config.DEFAULT_VOLUME === 80, 'DEFAULT_VOLUME wrong'));

// ══════════════════════════════════════════════════════════════
// 4. Stream helpers
// ══════════════════════════════════════════════════════════════
console.log('\n🌊 Stream');
test('swallowPipeErr is function', () => assert(typeof stream.swallowPipeErr === 'function'));
test('makePipeFast is function', () => assert(typeof stream.makePipeFast === 'function'));
test('makePipeEncode is function', () => assert(typeof stream.makePipeEncode === 'function'));
test('swallowPipeErr ignores EPIPE', () => {
  let called = false;
  const orig = console.warn;
  console.warn = () => { called = true; };
  stream.swallowPipeErr({ code: 'EPIPE', message: 'write EPIPE' });
  console.warn = orig;
  assert(!called, 'EPIPE should be suppressed');
});
test('swallowPipeErr reports real errors', () => {
  let called = false;
  const orig = console.warn;
  console.warn = () => { called = true; };
  stream.swallowPipeErr({ code: 'ENOENT', message: 'file not found' });
  console.warn = orig;
  assert(called, 'real errors should be reported');
});

// ══════════════════════════════════════════════════════════════
// 5. PlayerUI
// ══════════════════════════════════════════════════════════════
console.log('\n🎨 PlayerUI');
test('formatTime(0) = 0:00', () => assert(PlayerUI.formatTime(0) === '0:00'));
test('formatTime(65) = 1:05', () => assert(PlayerUI.formatTime(65) === '1:05'));
test('formatTime(3661) = 61:01', () => assert(PlayerUI.formatTime(3661) === '61:01'));
test('formatTime(null) = 0:00', () => assert(PlayerUI.formatTime(null) === '0:00'));
test('buildPlayingEmbed returns object with toJSON', () => {
  const embed = PlayerUI.buildPlayingEmbed(
    { title: 'Test', url: 'http://x', duration: 120, requestedBy: 'User', uploader: 'Artist', thumbnail: 'http://thumb' },
    { loop: 'off', volume: 80, currentIndex: 0, tracks: [{ title: 'Test' }], shuffle: false, stay: false, elapsed: 0 }
  );
  assert(embed && typeof embed.toJSON === 'function', 'not an EmbedBuilder');
  const json = embed.toJSON();
  assert(json.title === '🎵 MUSIC PANEL', 'wrong title');
});
test('buildControlRow1 returns 5 buttons', () => {
  const row = PlayerUI.buildControlRow1(false, false);
  const data = row.toJSON();
  assert(data.components.length === 5, `expected 5, got ${data.components.length}`);
});
test('buildControlRow2 returns 5 buttons', () => {
  const row = PlayerUI.buildControlRow2(false, false, true, true);
  const data = row.toJSON();
  assert(data.components.length === 5, `expected 5, got ${data.components.length}`);
});
test('buildControlRow1 has seek buttons', () => {
  const row = PlayerUI.buildControlRow1();
  const ids = row.toJSON().components.map(c => c.custom_id);
  assert(ids[0] === 'seek_back', `first should be seek_back, got ${ids[0]}`);
  assert(ids[4] === 'seek_fwd', `last should be seek_fwd, got ${ids[4]}`);
  assert(!ids.includes('vol_down'), 'vol_down should be removed');
});
test('buildControlRow2 has stay button', () => {
  const row = PlayerUI.buildControlRow2();
  const ids = row.toJSON().components.map(c => c.custom_id);
  assert(ids.includes('stay'), 'missing stay');
  assert(!ids.includes('autoplay'), 'autoplay should be removed');
});

// ══════════════════════════════════════════════════════════════
// 6. MusicManager logic
// ══════════════════════════════════════════════════════════════
console.log('\n🎵 MusicManager');
const manager = new MusicManager();
const GUILD = 'test-guild-1';

test('getQueue creates default queue', () => {
  const q = manager.getQueue(GUILD);
  assert(q.tracks.length === 0, 'tracks not empty');
  assert(q.currentIndex === -1, 'currentIndex wrong');
  assert(q.loop === 'off', 'loop wrong');
  assert(q.volume === 80, 'volume wrong');
  assert(q.stay === true, 'stay wrong (default = true for stay-forever semantics)');
  assert(q.shuffle === false, 'shuffle wrong');
});

test('toggleLoop cycles: off → track → queue → off', () => {
  const q = manager.getQueue(GUILD);
  assert(q.loop === 'off', 'start: off');
  manager.toggleLoop(GUILD);
  assert(q.loop === 'track', 'off → track');
  manager.toggleLoop(GUILD);
  assert(q.loop === 'queue', 'track → queue');
  manager.toggleLoop(GUILD);
  assert(q.loop === 'off', 'queue → off');
});

test('toggleStay toggles', () => {
  const q = manager.getQueue(GUILD);
  q.stay = false;
  const result = manager.toggleStay(GUILD);
  assert(result === true, 'should be true');
  assert(q.stay === true, 'stay should be true');
  manager.toggleStay(GUILD);
  assert(q.stay === false, 'stay should be false');
});

test('toggleShuffle toggles', () => {
  const q = manager.getQueue(GUILD);
  q.shuffle = false;
  manager.toggleShuffle(GUILD);
  assert(q.shuffle === true, 'should be true');
  manager.toggleShuffle(GUILD);
  assert(q.shuffle === false, 'should be false');
});

test('setVolume clamps 0-100', () => {
  manager.setVolume(GUILD, 150);
  assert(manager.getQueue(GUILD).volume === 100, 'should clamp to 100');
  manager.setVolume(GUILD, -10);
  assert(manager.getQueue(GUILD).volume === 0, 'should clamp to 0');
  manager.setVolume(GUILD, 50);
  assert(manager.getQueue(GUILD).volume === 50, 'should be 50');
});

test('pause/resume requires player', () => {
  const q = manager.getQueue(GUILD);
  q.playing = true; q.paused = false;
  // No player created → pause should NOT set flag
  manager.pause(GUILD);
  assert(q.paused === false, 'should not pause without player');
  // Create player, then pause should work
  manager.ensurePlayer(GUILD);
  manager.pause(GUILD);
  assert(q.paused === true, 'should be paused');
  manager.resume(GUILD);
  assert(q.paused === false, 'should be resumed');
});

test('stop clears queue (Stay ON keeps bot)', async () => {
  const q = manager.getQueue(GUILD);
  q.tracks = [{ title: 'test' }];
  q.currentIndex = 0;
  q.stay = true;
  const r = await manager.stop(GUILD);
  const q2 = manager.getQueue(GUILD);
  assert(r.left === false, 'stay ON → stop should NOT leave');
  assert(q2.tracks.length === 0, 'tracks should be empty');
});

test('stop leaves when Stay OFF', async () => {
  const q = manager.getQueue(GUILD);
  q.tracks = [{ title: 'test' }];
  q.currentIndex = 0;
  q.stay = false;
  const r = await manager.stop(GUILD);
  assert(r.left === true, 'stay OFF → stop should leave');
});

test('cleanup test guild', () => {
  manager.disconnect(GUILD);
});

// ══════════════════════════════════════════════════════════════
// 7. Commands validation
// ══════════════════════════════════════════════════════════════
console.log('\n📋 Commands');
test(`${commands.length} commands registered`, () => assert(commands.length === 11, `expected 11, got ${commands.length}`));
test('all commands have name', () => {
  for (const cmd of commands) {
    const json = cmd.toJSON();
    assert(json.name, `command missing name`);
    assert(json.description, `command ${json.name} missing description`);
  }
});
test('/play has query option', () => {
  const play = commands.find(c => c.name === 'play');
  const json = play.toJSON();
  assert(json.options.some(o => o.name === 'query'), 'missing query option');
});
test('/volume has level option', () => {
  const vol = commands.find(c => c.name === 'volume');
  const json = vol.toJSON();
  assert(json.options.some(o => o.name === 'level'), 'missing level option');
});

// ══════════════════════════════════════════════════════════════
// Results
// ══════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
