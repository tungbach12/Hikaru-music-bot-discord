// playlists.js — per-guild played-history + saved playlists (persists to playlists.json)
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'playlists.json');
const HISTORY_LIMIT = 200; // keep last 200 played per guild

function load() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) || { history: {}, playlists: {} };
  } catch {
    return { history: {}, playlists: {} };
  }
}

function save(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.warn('[playlists] save failed:', e.message);
  }
}

function cleanTrack(t) {
  if (!t || !t.url) return null;
  return {
    id: t.id || '',
    title: t.title || 'Unknown',
    url: t.url,
    duration: t.duration || 0,
    uploader: t.uploader || '',
    thumbnail: t.thumbnail || '',
  };
}

// Record a played song into the guild's history (most-recent-first, dedup by url).
function recordPlay(guildId, track) {
  const t = cleanTrack(track);
  if (!t) return;
  const data = load();
  data.history[guildId] = data.history[guildId] || [];
  data.history[guildId] = data.history[guildId].filter(x => x.url !== t.url);
  data.history[guildId].unshift(t);
  if (data.history[guildId].length > HISTORY_LIMIT) {
    data.history[guildId] = data.history[guildId].slice(0, HISTORY_LIMIT);
  }
  data.playlists[guildId] = data.playlists[guildId] || {};
  save(data);
}

function getHistory(guildId, limit = 25) {
  const data = load();
  return (data.history[guildId] || []).slice(0, limit);
}

function getHistoryCount(guildId) {
  const data = load();
  return (data.history[guildId] || []).length;
}

function getPlaylistNames(guildId) {
  const data = load();
  return Object.keys(data.playlists[guildId] || {});
}

function getPlaylist(guildId, name) {
  const data = load();
  return (data.playlists[guildId] || {})[name] || null;
}

function savePlaylist(guildId, name, tracks) {
  if (!name || !tracks || !tracks.length) return false;
  const data = load();
  data.playlists[guildId] = data.playlists[guildId] || {};
  data.playlists[guildId][name] = {
    name,
    createdAt: Date.now(),
    tracks: tracks.map(cleanTrack).filter(Boolean),
  };
  save(data);
  return true;
}

function deletePlaylist(guildId, name) {
  const data = load();
  if (data.playlists[guildId] && data.playlists[guildId][name]) {
    delete data.playlists[guildId][name];
    save(data);
    return true;
  }
  return false;
}

function sanitizeName(name) {
  return (name || '').toString().trim().slice(0, 60).replace(/[\u0000-\u001f]/g, '');
}

module.exports = {
  recordPlay, getHistory, getHistoryCount,
  getPlaylistNames, getPlaylist, savePlaylist, deletePlaylist, sanitizeName, HISTORY_LIMIT,
};
