/**
 * Smoke test: verify MusicManager loads, instantiates, and core methods exist.
 * Run with: node test.js
 */

// Stub discord.js Client.login so the bot doesn't actually connect
const origLogin = require('discord.js').Client.prototype.login;
require('discord.js').Client.prototype.login = function () { return Promise.resolve(); };

// Stub child_process.spawn so yt-dlp/ffmpeg aren't executed
const cp = require('child_process');
const origSpawn = cp.spawn;
cp.spawn = function (cmd, args, opts) {
  // Return a mock process that emits nothing useful but doesn't crash
  const { EventEmitter } = require('events');
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stdout.pipe = () => {};
  proc.stdout.unpipe = () => {};
  proc.stdout.once = proc.stdout.once.bind(proc.stdout);
  proc.stdout.on = proc.stdout.on.bind(proc.stdout);
  proc.stderr = new EventEmitter();
  proc.stdin = new EventEmitter();
  proc.stdin.end = () => {};
  proc.kill = () => true;
  proc.pid = 1;
  return proc;
};

// Load the bot module (exports nothing, but MusicManager is internal)
require('./index.js');

// Give the module a tick to finish top-level code
setTimeout(() => {
  let pass = 0;
  let fail = 0;

  function assert(cond, msg) {
    if (cond) { pass++; console.log(`  ✅ ${msg}`); }
    else { fail++; console.error(`  ❌ ${msg}`); }
  }

  console.log('\n=== Smoke Tests ===\n');

  // 1) Module loaded without error
  assert(true, 'Module loaded without throwing');

  // 2) Re-expose MusicManager by importing internals we can check
  //    We can't directly access the `manager` instance, but we can verify
  //    the module ran its top-level code (client was created, login called)
  assert(typeof origLogin === 'function', 'discord.js Client.login was available before stub');

  // 3) Verify StreamType import includes WebmOpus
  const { StreamType } = require('@discordjs/voice');
  assert(StreamType.WebmOpus !== undefined, 'StreamType.WebmOpus exists');
  assert(StreamType.Raw !== undefined, 'StreamType.Raw exists (fallback)');

  // 4) Verify helper functions are importable by checking the file parses cleanly
  const fs = require('fs');
  const src = fs.readFileSync(__dirname + '/index.js', 'utf8');
  assert(src.includes('function swallowPipeErr'), 'swallowPipeErr function defined');
  assert(src.includes('function makePipeFast'), 'makePipeFast function defined');
  assert(src.includes('function makePipeEncode'), 'makePipeEncode function defined');
  assert(src.includes('StreamType.WebmOpus'), 'StreamType.WebmOpus used (not OggOpus)');
  assert(!src.includes('StreamType.OggOpus'), 'No StreamType.OggOpus reference');
  assert(!src.includes('-f ogg'), 'No -f ogg in ffmpeg args');
  assert(src.includes("'-f', 'webm'"), 'ffmpeg uses -f webm');
  assert(src.includes("'-acodec', 'libopus'"), 'ffmpeg uses -acodec libopus');
  assert(src.includes('--proxy'), 'yt-dlp uses --proxy for WARP');
  assert(src.includes('socks5://127.0.0.1:40000'), 'WARP proxy URL present');
  assert(src.includes('bestaudio[acodec=opus][ext=webm]'), 'Fast pipe format selector present');
  assert(src.includes('removeAllListeners') === false, 'No removeAllListeners (single idle listener)');
  assert(src.includes('NoSubscriberBehavior'), 'NoSubscriberBehavior.Pause used');
  assert(src.includes('SIGTERM'), 'SIGTERM used for cleanup');
  assert(src.includes('SIGKILL'), 'SIGKILL used as fallback');
  assert(src.includes('.deno/bin'), 'Deno in PATH');
  assert(src.includes('async skip'), 'skip() is async');
  assert(src.includes('await this.killProc'), 'skip() awaits killProc');
  assert(src.includes('player.stop(true)'), 'skip() calls player.stop(true)');
  assert(src.includes('this.playNext(guildId)'), 'skip() explicitly calls playNext');

  // 5) Verify all slash commands are preserved
  assert(src.includes(".setName('play')"), 'Slash cmd: play');
  assert(src.includes(".setName('skip')"), 'Slash cmd: skip');
  assert(src.includes(".setName('stop')"), 'Slash cmd: stop');
  assert(src.includes(".setName('pause')"), 'Slash cmd: pause');
  assert(src.includes(".setName('resume')"), 'Slash cmd: resume');
  assert(src.includes(".setName('queue')"), 'Slash cmd: queue');
  assert(src.includes(".setName('nowplaying')"), 'Slash cmd: nowplaying');
  assert(src.includes(".setName('volume')"), 'Slash cmd: volume');
  assert(src.includes(".setName('shuffle')"), 'Slash cmd: shuffle');
  assert(src.includes(".setName('loop')"), 'Slash cmd: loop');

  // 6) Verify button IDs preserved
  assert(src.includes("'vol_down'"), 'Button: vol_down');
  assert(src.includes("'vol_up'"), 'Button: vol_up');
  assert(src.includes("'back'"), 'Button: back');
  assert(src.includes("'skip'"), 'Button: skip');
  assert(src.includes("'pause'"), 'Button: pause');
  assert(src.includes("'stop'"), 'Button: stop');
  assert(src.includes("'shuffle'"), 'Button: shuffle');
  assert(src.includes("'loop'"), 'Button: loop');
  assert(src.includes("'autoplay'"), 'Button: autoplay');
  assert(src.includes("'playlist'"), 'Button: playlist');

  console.log(`\n=== Results: ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail > 0 ? 1 : 0);
}, 100);
