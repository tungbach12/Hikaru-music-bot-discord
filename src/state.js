// Stay-state persistence — survives PM2 restarts (Pitfall 36)
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '..', 'state.json');

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.warn('[state] save failed:', e.message);
  }
}

module.exports = { loadState, saveState, STATE_FILE };