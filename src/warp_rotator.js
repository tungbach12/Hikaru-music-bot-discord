#!/usr/bin/env node
/**
 * warp_rotator.js — rotate Cloudflare WARP egress IP on demand.
 *
 * WARP has NO built-in "rotate IP" command. Re-registering the client
 * (registration delete → new) assigns a fresh WARP identity, which yields a
 * NEW egress IP (verified 2026-08-20: 104.28.222.43 → 104.28.222.46).
 *
 * Usage:
 *   node src/warp_rotator.js          → rotate, print new egress IP
 *   node src/warp_rotator.js --check  → just print current egress IP
 *
 * Returns exit 0 + prints "ROTATED:<ip>" (or "CURRENT:<ip>") on success.
 */
const { execFile } = require('child_process');

const WARP_BIN = process.env.WARP_BIN || 'warp-cli';
const PROXY = process.env.WARP_PROXY_URL || 'socks5://127.0.0.1:40000';
const ROTATE = process.argv.includes('--check') === false;
const EGRESS_CHECK = `https://api.ipify.org`;

function run(cmd, args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.join(' ')}: ${(stderr||err.message).slice(0,200)}`));
      else resolve((stdout||'').trim());
    });
  });
}

async function getEgress() {
  // curl through the WARP socks proxy to see our public egress IP
  const { execFileSync } = require('child_process');
  try {
    const out = execFileSync('curl', ['-s', '--max-time', '10', '--socks5-hostname', PROXY.replace('socks5://',''), EGRESS_CHECK], { encoding: 'utf8', timeout: 15000 });
    return out.trim();
  } catch (e) {
    return 'unknown';
  }
}

async function main() {
  const before = await getEgress();
  if (!ROTATE) {
    console.log(`CURRENT:${before}`);
    return;
  }
  try {
    // 1. disconnect
    await run('sudo', [WARP_BIN, 'disconnect']);
    // 2. delete + re-register (fresh identity → likely new egress IP)
    await run('sudo', [WARP_BIN, 'registration', 'delete']);
    await new Promise(r => setTimeout(r, 1500));
    await run('sudo', [WARP_BIN, 'registration', 'new']);
    await run('sudo', [WARP_BIN, 'connect']);
    // 3. wait for tunnel to establish
    await new Promise(r => setTimeout(r, 4000));
    const after = await getEgress();
    const ok = after !== 'unknown' && after !== before;
    console.log(`ROTATED:${after}${ok ? '' : ` (unchanged from ${before})`}`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    // Best effort: try to reconnect so WARP isn't left down
    try { await run('sudo', [WARP_BIN, 'connect']); } catch {}
    console.error(`ROTATE_FAILED:${e.message}`);
    process.exit(1);
  }
}

main();
