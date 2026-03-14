// ============================================================
// HiveStream v4.0.3
// WebTorrent P2P theater inside CyTube rooms
// https://github.com/aolcyberchat-gpu/P2P-Theater-Core
// ============================================================
//
// ARCHITECTURE
// ─────────────────────────────────────────────────────────────
// Coordinator (highest rank user) initiates playback.
// All other clients receive a single relay and join the swarm.
// WebRTC peers exchange pieces — server bandwidth drops as
// the room fills up. IndexedDB caches pieces across sessions
// so returning viewers seed immediately without re-downloading.
//
// RELAY PROTOCOL (one message, no encoding issues)
//   !hs _i <40charHash> <base64WebseedUrl>
//   Hash = btih infohash. Webseed = base64(direct MP4 URL).
//   base64 has no & chars so CyTube link_regex never wraps it.
//
// STATE MACHINE
//   IDLE → FETCHING → METADATA → BUFFERING → PLAYING → SEEDING
//   Only coordinator leaves IDLE on their own.
//   Everyone else transitions on receiving _i relay.
//
// COMMANDS
//   !hs top              trending videos (framatube.org)
//   !hs search <query>   federated PeerTube search
//   !hs pick <n>         play result n
//   !hs info <n>         details for result n
//   !hs stop             stop playback
//   !hs status           swarm stats
//   !hs sync             broadcast timestamp to room
//   !hs seek <s>         seek all clients
//   !hs help             list commands
//
// DEPLOY
//   Channel Settings → Admin Settings → External Javascript
//   → paste jsDelivr URL
// ============================================================

(function () {
'use strict';

const V = '4.0.3';
if (window.__HS === V) return;
window.__HS = V;

// ── CONFIG ───────────────────────────────────────────────────
const CFG = {
  cmd:        '!hs',
  seedOnly:   false,   // true = silent background seeder, no UI
  syncThres:  2.5,     // seconds before force-seek on sync
  syncMs:     30000,   // auto-sync interval
  chatBurst:  20,      // CyTube antiflood burst (room setting)
  chatDelay:  100,     // ms between messages after burst

  // 4 reliable WSS trackers — quality over quantity
  trackers: [
    'wss://tracker.openwebtorrent.com',
    'wss://tracker.webtorrent.dev',
    'wss://tracker.btorrent.xyz',
    'wss://tracker.fastcast.nz',
  ],

  // PeerTube search
  searchApi: 'https://sepiasearch.org/api/v1/search/videos',
  topApi:    'https://framatube.org/api/v1/videos?sort=-trending&count=20&hasWebtorrentVideo=true',

  // IndexedDB
  idbName:    'HiveStream4',
  idbVersion: 1,
};

// ── KNOWN HASHES ────────────────────────────────────────────
// webseed = direct CORS-open MP4 URL
const KNOWN = {
  'dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c': {
    name: 'Big Buck Bunny',
    // torrentUrl: coordinator fetches this as Uint8Array → instant metadata
    // ws: webseed for zero-peer HTTP download
    torrentUrl: 'https://webtorrent.io/torrents/big-buck-bunny.torrent',
    ws: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
  },
  '08ada5a7a6183aae1e09d831df6748d566095a10': {
    name: 'Sintel',
    torrentUrl: 'https://webtorrent.io/torrents/sintel.torrent',
    ws: 'https://archive.org/download/Sintel/sintel-2048-surround.mp4',
  },
  'a88fda5954e89178c372716a6a78b8180ed4dad3': {
    name: 'Tears of Steel',
    torrentUrl: 'https://webtorrent.io/torrents/tears-of-steel.torrent',
    ws: 'https://archive.org/download/tears-of-steel/tears_of_steel_1080p.mp4',
  },
  '6a9759bffd5c0af65319979fb7832189f4f3c35d': {
    name: 'Elephants Dream',
    torrentUrl: 'https://webtorrent.io/torrents/elephants-dream.torrent',
    ws: 'https://archive.org/download/ElephantsDream/ed_1024_512kb.mp4',
  },
};

// ── STATE ────────────────────────────────────────────────────
// Single state machine — eliminates all race conditions
const S = {
  // Playback state
  state:   'IDLE',   // IDLE|FETCHING|METADATA|BUFFERING|PLAYING|SEEDING
  wt:      null,     // WebTorrent client
  torrent: null,     // active torrent
  video:   null,     // <video> element
  results: [],       // last search/top results

  // Identity
  myName:  '',
  myRank:  -1,

  // Chat queue
  chatQueue:  [],
  chatTimer:  null,
  chatCount:  0,
  chatReset:  null,

  // Sync
  syncTimer: null,

  // IDB
  idb: null,
};

// ── LOGGING ──────────────────────────────────────────────────
const dbLines = [];

function dbWrite(level, args) {
  const ts = new Date().toTimeString().slice(0, 8);
  const msg = args.map(function (a) {
    if (a === null) return 'null';
    if (a === undefined) return 'undefined';
    try { return typeof a === 'object' ? JSON.stringify(a) : String(a); }
    catch (e) { return String(a); }
  }).join(' ');
  const prefix = level === 'W' ? '⚠ ' : level === 'E' ? '✖ ' : '';
  const line = '[' + ts + '] ' + prefix + msg;
  dbLines.push(line);
  if (dbLines.length > 200) dbLines.shift();
  const el = document.getElementById('hs-dblog');
  if (el) { el.textContent = dbLines.slice(-50).join('\n'); el.scrollTop = el.scrollHeight; }
}

const log    = function () { dbWrite('L', Array.from(arguments)); console.log('[HS]', ...arguments); };
const warn   = function () { dbWrite('W', Array.from(arguments)); console.warn('[HS]', ...arguments); };
const errlog = function () { dbWrite('E', Array.from(arguments)); console.error('[HS]', ...arguments); };

// ── STATE TRANSITIONS ────────────────────────────────────────
function transition(newState) {
  log('state:', S.state, '→', newState);
  S.state = newState;
  updateStateUI(newState);
}

function updateStateUI(state) {
  const el = document.getElementById('hs-state');
  if (!el) return;
  const labels = {
    IDLE:      '○ idle',
    FETCHING:  '⟳ fetching',
    METADATA:  '⟳ metadata',
    BUFFERING: '▼ buffering',
    PLAYING:   '▶ playing',
    SEEDING:   '▲ seeding',
  };
  el.textContent = labels[state] || state;
  el.className = 'hs-state hs-state-' + state.toLowerCase();
}

// ── CHAT QUEUE ───────────────────────────────────────────────
function chat(text) {
  if (!window.socket) return;
  S.chatQueue.push(text);
  if (!S.chatTimer) flushChat();
}

function flushChat() {
  if (!S.chatQueue.length) { S.chatTimer = null; return; }
  if (!S.chatReset) {
    S.chatCount = 0;
    S.chatReset = setTimeout(function () { S.chatCount = 0; S.chatReset = null; }, 5000);
  }
  socket.emit('chatMsg', { msg: S.chatQueue.shift() });
  S.chatCount++;
  const delay = S.chatCount < CFG.chatBurst ? 150 : CFG.chatDelay;
  S.chatTimer = setTimeout(flushChat, delay);
}

function relay(body) { chat(CFG.cmd + ' ' + body); }

// ── RELAY ENCODER/DECODER ────────────────────────────────────
// _i relay uses base64 for webseed URL — no & chars, no CyTube HTML encoding issues
function encodeRelay(hash, wsUrl) {
  // base64 encode the webseed URL so CyTube link_regex never touches it
  const b64 = btoa(wsUrl).replace(/=/g, '');  // strip padding, safe in magnet context
  return '_i ' + hash + ' ' + b64;
}

function decodeRelay(hashArg, b64Arg) {
  const hash = hashArg.toLowerCase();
  let ws = '';
  try {
    // Restore padding if stripped
    const pad = b64Arg.length % 4;
    const padded = pad ? b64Arg + '='.repeat(4 - pad) : b64Arg;
    ws = atob(padded);
  } catch (e) {
    warn('base64 decode failed:', e.message);
  }
  return { hash, ws };
}

// CyTube still HTML-encodes & in other relay types — decode full body first
function decodeBody(body) {
  if (!body) return body;
  let s = body;
  // Replace <a href="URL">...</a> with just URL
  if (s.indexOf('<') >= 0) {
    s = s.replace(/<a[^>]+href="([^"]*)"[^>]*>[^<]*<\/a>/gi, function (_, href) { return href; });
    s = s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  // Decode HTML entities everywhere
  s = s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  return s;
}

// ── MAGNET BUILDER ───────────────────────────────────────────
function buildMagnet(hash, ws, dn) {
  let m = 'magnet:?xt=urn:btih:' + hash;
  if (dn) m += '&dn=' + encodeURIComponent(dn);
  if (ws) m += '&ws=' + encodeURIComponent(ws);
  CFG.trackers.forEach(function (tr) { m += '&tr=' + encodeURIComponent(tr); });
  return m;
}

// ── COORDINATOR DETECTION ────────────────────────────────────
// Highest rank = coordinator. Tie → alphabetical. Deterministic, no negotiation.
function isCoordinator() {
  // Fast path: rank < 1.5 = guest/regular, never coordinator
  if (S.myRank < 1.5) return false;
  // Check if anyone else in the room has a higher rank
  const items = Array.from(document.querySelectorAll('#userlist .userlist_item'));
  if (!items.length) return true; // userlist empty — trust my rank
  let highestOther = 0;
  items.forEach(function (el) {
    const sp = el.querySelector('span:nth-child(2)');
    const name = sp ? sp.textContent.trim() : '';
    if (!name || name === S.myName) return;
    const c = (el.className || '') + (sp ? (sp.className || '') : '');
    let r = 1;
    if (c.includes('userlist_owner')) r = 5;
    else if (c.includes('userlist_op')) r = 3;
    else if (c.includes('userlist_leader')) r = 2;
    if (r > highestOther) highestOther = r;
  });
  return S.myRank >= highestOther;
}
// ── WEBTORRENT CLIENT ────────────────────────────────────────
function mkClient() {
  const wt = new window.WebTorrent();
  wt.on('error', function (e) { errlog('WT client:', e.message || e); });
  return wt;
}

function startSwarm(hash, ws, dn) {
  if (S.state !== 'IDLE') {
    log('startSwarm: not IDLE (state=' + S.state + '), ignoring');
    return;
  }
  if (!S.wt) S.wt = mkClient();
  transition('METADATA');

  // Check IDB cache first — if we have pieces, load them as seed
  idbGetTorrent(hash, function (cachedBuf) {
    const magnet = buildMagnet(hash, ws, dn);
    log('adding magnet, ws=' + (ws ? ws.slice(0, 60) : 'none'));

    let t;
    try {
      if (cachedBuf) {
        log('IDB cache hit for', hash, '— loading as seed');
        t = S.wt.add(new Uint8Array(cachedBuf), { announce: CFG.trackers });
      } else {
        t = S.wt.add(magnet);
      }
    } catch (e) {
      log('wt.add error:', e.message, '— trying wt.get for', hash);
      t = S.wt.get(hash);
      if (!t) {
        // Last resort: destroy and recreate the wt client
        errlog('wt.get also failed, recreating client');
        S.wt.destroy(function () {
          S.wt = mkClient();
          const t2 = S.wt.add(magnet);
          S.torrent = t2;
          bindTorrent(t2);
        });
        return;
      }
      log('recovered existing torrent from wt.get');
    }

    S.torrent = t;
    bindTorrent(t);
  });
}

function bindTorrent(t) {
  t.on('infoHash', function () {
    log('infoHash:', t.infoHash);
  });

  t.on('metadata', function () {
    log('metadata:', t.name, '— files:', t.files.length);
    transition('BUFFERING');
    chat('"' + t.name + '" — buffering…');
    const el = document.getElementById('currenttitle');
    if (el) el.textContent = t.name;
    attachVideo(t);
    startHUD(t);
    startSyncTimer();
  });

  t.on('ready', function () {
    log('ready:', t.name);
    transition('PLAYING');
    chat('"' + t.name + '" ready — ' + t.numPeers + ' peer(s)');
  });

  t.on('done', function () {
    log('done — seeding');
    transition('SEEDING');
    idbStoreTorrent(t);
    chat('Seeding "' + t.name + '" to room');
  });

  t.on('wire', function (wire) {
    log('peer connected:', wire.remoteAddress || 'webrtc', '— total:', t.numPeers);
  });

  t.on('warning', function (w) { warn('torrent warn:', w.message || w); });
  t.on('error', function (e) {
    const msg = e.message || String(e);
    errlog('torrent error:', msg);
    // Duplicate torrent — wt client still has it from a prior session
    // Recover by grabbing the existing instance via wt.get()
    if (msg.indexOf('duplicate') >= 0 && t.infoHash) {
      const existing = S.wt.get(t.infoHash);
      if (existing && existing !== t) {
        log('duplicate recovery: rebinding to existing torrent', t.infoHash);
        S.torrent = existing;
        // If it already has metadata, attach video directly
        if (existing.files && existing.files.length) {
          transition('BUFFERING');
          attachVideo(existing);
          startHUD(existing);
          startSyncTimer();
        } else {
          transition('METADATA');
          bindTorrent(existing);
        }
        return;
      }
    }
    transition('IDLE');
    setOverlay('Error: ' + msg);
  });
}

function attachVideo(t) {
  const overlay = document.getElementById('hs-overlay');
  if (overlay) overlay.style.display = 'none';

  // Find best playable file — prefer mp4/webm, largest if tie
  const PLAYABLE = /\.(mp4|webm|mkv|mov|ogv|ogg|m4v)$/i;
  let best = null;
  t.files.forEach(function (f) {
    if (!best) { best = f; return; }
    const fv = PLAYABLE.test(f.name), bv = PLAYABLE.test(best.name);
    if (fv && !bv) { best = f; return; }
    if (f.length > best.length) best = f;
  });

  if (!best) { errlog('no playable file found in torrent'); return; }
  log('renderTo:', best.name, '(' + Math.round(best.length / 1e6) + 'MB)');
  best.renderTo(S.video, function (err) {
    if (err) errlog('renderTo error:', err.message);
  });
}

// ── HUD ──────────────────────────────────────────────────────
function startHUD(t) {
  if (S.hudTimer) clearInterval(S.hudTimer);
  S.hudTimer = setInterval(function () {
    if (!S.torrent) { clearInterval(S.hudTimer); S.hudTimer = null; return; }
    const pct = t.length ? (t.downloaded / t.length * 100).toFixed(1) : '?';
    const spd = fmtSpd(t.downloadSpeed) + '▼ ' + fmtSpd(t.uploadSpeed) + '▲';
    const txt = pct + '% · ' + t.numPeers + 'p · ' + spd;
    const el = document.getElementById('hs-hud');
    if (el) el.textContent = txt;
  }, 2000);
}

// ── STOP ─────────────────────────────────────────────────────
function stopAll(announce) {
  if (S.hudTimer) { clearInterval(S.hudTimer); S.hudTimer = null; }
  if (S.syncTimer) { clearInterval(S.syncTimer); S.syncTimer = null; }
  if (S.torrent) {
    S.torrent.destroy(function () { S.torrent = null; });
  }
  if (S.video) { S.video.pause(); S.video.src = ''; }
  transition('IDLE');
  setOverlay('Nothing Playing — search or click Top 10');
  const hud = document.getElementById('hs-hud');
  if (hud) hud.textContent = '';
  if (announce) chat('HiveStream stopped.');
}

// ── SYNC ─────────────────────────────────────────────────────
function startSyncTimer() {
  if (S.syncTimer) return;
  S.syncTimer = setInterval(function () {
    if (S.video && !S.video.paused && isCoordinator()) {
      relay('_s ' + S.video.currentTime.toFixed(2));
    }
  }, CFG.syncMs);
}

function applySync(t) {
  if (!S.video || isNaN(t)) return;
  if (Math.abs(S.video.currentTime - t) > CFG.syncThres) {
    log('sync seek:', t);
    S.video.currentTime = t;
  }
}

// ── SEARCH / TOP ─────────────────────────────────────────────
function cmdTop() {
  if (!isCoordinator()) { chat('Only the room coordinator can start videos.'); return; }
  if (S.state !== 'IDLE') { chat('Stop current video first: !hs stop'); return; }
  transition('FETCHING');
  setOverlay('Fetching trending…');
  fetch(CFG.topApi)
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (d) {
      transition('IDLE');
      S.results = d.data || [];
      if (!S.results.length) { chat('No results.'); setOverlay('Nothing Playing'); return; }
      showGrid(S.results);
      chat('Trending (' + S.results.length + ') — !hs pick <n> or click thumbnail:');
      S.results.slice(0, 8).forEach(function (v, i) {
        chat((i + 1) + '. [' + fmtDur(v.duration) + '] ' + v.name);
      });
    })
    .catch(function (e) {
      transition('IDLE');
      setOverlay('Nothing Playing');
      chat('Top error: ' + e.message);
    });
}

function cmdSearch(q) {
  if (!isCoordinator()) { chat('Only the room coordinator can search.'); return; }
  if (S.state !== 'IDLE') { chat('Stop current video first: !hs stop'); return; }
  transition('FETCHING');
  setOverlay('Searching…');
  const url = CFG.searchApi + '?search=' + encodeURIComponent(q) + '&count=20&sort=-trending';
  fetch(url)
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (d) {
      transition('IDLE');
      S.results = d.data || [];
      if (!S.results.length) { chat('No results for: ' + q); setOverlay('Nothing Playing'); return; }
      showGrid(S.results);
      chat(S.results.length + ' results for "' + q + '":');
      S.results.slice(0, 8).forEach(function (v, i) {
        const h = v.account && v.account.host ? v.account.host : '?';
        chat((i + 1) + '. [' + fmtDur(v.duration) + '] ' + v.name + ' (' + h + ')');
      });
    })
    .catch(function (e) {
      transition('IDLE');
      setOverlay('Nothing Playing');
      chat('Search error: ' + e.message);
    });
}

function cmdPick(n) {
  if (!isCoordinator()) { chat('Only the room coordinator can pick videos.'); return; }
  const v = S.results[n - 1];
  if (!v) { chat('No result ' + n + '. Run !hs top or search first.'); return; }

  const host = v.account && v.account.host ? 'https://' + v.account.host : 'https://framatube.org';
  const uuid = v.uuid || v.id || v.shortUUID;
  if (!uuid) { chat('No video ID in result ' + n); return; }

  transition('FETCHING');
  setOverlay('Fetching video info…');

  fetch(host + '/api/v1/videos/' + uuid)
    .then(function (r) { if (!r.ok) throw new Error('API ' + r.status); return r.json(); })
    .then(function (data) {
      // Only use data.files (WebTorrent mp4) — NOT streamingPlaylists (HLS)
      const files = (data.files || []).filter(function (f) {
        return (f.magnetUri || f.fileUrl) && !/-hls\./i.test(f.torrentUrl || '');
      });

      if (!files.length) {
        transition('IDLE');
        setOverlay('Nothing Playing');
        chat('\u26a0 "' + data.name + '" has no WebTorrent files (HLS-only instance). Try another.');
        return;
      }

      // Pick best resolution ≤ 720p
      const sorted = files.slice().sort(function (a, b) {
        const ra = parseInt((a.resolution && (a.resolution.id || a.resolution.label)) || 0);
        const rb = parseInt((b.resolution && (b.resolution.id || b.resolution.label)) || 0);
        return rb - ra;
      });
      const target = sorted.find(function (f) {
        return parseInt((f.resolution && (f.resolution.id || f.resolution.label)) || 0) <= 720;
      }) || sorted[sorted.length - 1];

      // Prefer fileUrl (direct MP4, works as webseed) over magnetUri
      const ws = target.fileUrl || null;
      const mag = target.magnetUri || null;

      // Extract hash from magnet
      let hash = null;
      if (mag) {
        const m = mag.match(/urn:btih:([0-9a-f]{40})/i);
        if (m) hash = m[1].toLowerCase();
      }

      if (!hash) {
        transition('IDLE');
        setOverlay('Nothing Playing');
        chat('Could not extract hash from "' + data.name + '"');
        return;
      }

      const res = String((target.resolution && (target.resolution.id || target.resolution.label)) || '?');
      chat('Playing: "' + data.name + '" [' + res + 'p] — relaying to room');
      setOverlay('Connecting…');

      // Coordinator starts their own swarm first
      startSwarm(hash, ws, data.name);

      // Broadcast _i relay to all clients
      // base64 webseed = no & chars, no CyTube HTML encoding issues
      if (ws) {
        relay(encodeRelay(hash, ws));
      } else {
        // No fileUrl — use magnet hash only, clients will peer with coordinator
        relay('_i ' + hash + ' -');
      }
    })
    .catch(function (e) {
      transition('IDLE');
      setOverlay('Nothing Playing');
      chat('Pick error: ' + e.message);
    });
}

function cmdPickHash(hash) {
  if (!isCoordinator()) { chat('Only the room coordinator can start videos.'); return; }
  if (S.state !== 'IDLE') { chat('Stop current video first: !hs stop'); return; }
  const k = KNOWN[hash];
  const ws = k ? k.ws : null;
  const name = k ? k.name : hash.slice(0, 8) + '…';
  chat('Loading: ' + name);

  if (k && k.torrentUrl) {
    // Coordinator fetches .torrent file → gets metadata immediately →
    // shares metadata to peers via ut_metadata WebRTC extension.
    // Peers add via magnet and receive metadata from coordinator.
    transition('METADATA');
    setOverlay('Fetching torrent…');
    log('fetching .torrent for coordinator:', k.torrentUrl);
    fetch(k.torrentUrl)
      .then(function (r) {
        const ct = (r.headers.get('content-type') || '').toLowerCase();
        if (!r.ok) throw new Error('HTTP ' + r.status);
        if (ct.indexOf('html') >= 0) throw new Error('got HTML not .torrent');
        return r.arrayBuffer();
      })
      .then(function (buf) {
        const ua = new Uint8Array(buf);
        // Sanity: valid .torrent starts with 'd' (0x64 = bencoded dict)
        if (ua[0] !== 0x64) throw new Error('not a torrent (first byte=0x' + ua[0].toString(16) + ')');
        log('.torrent OK:', buf.byteLength, 'bytes — adding to wt');
        if (!S.wt) S.wt = mkClient();
        let t;
        try {
          t = S.wt.add(ua, { announce: CFG.trackers });
        } catch (e) {
          t = S.wt.get(hash);
          if (!t) { errlog('Cannot add or get torrent:', e.message); transition('IDLE'); return; }
          log('reusing existing torrent from wt.get');
        }
        S.torrent = t;
        bindTorrent(t);
        // Broadcast _i to all peers AFTER adding — coordinator now has metadata
        // Peers add via magnet and connect to coordinator for ut_metadata exchange
        if (ws) relay(encodeRelay(hash, ws));
        else relay('_i ' + hash + ' -');
      })
      .catch(function (e) {
        warn('.torrent fetch failed:', e.message, '— falling back to magnet');
        // Magnet fallback — less reliable but still works if trackers respond
        startSwarm(hash, ws, name);
        if (ws) relay(encodeRelay(hash, ws));
        else relay('_i ' + hash + ' -');
      });
  } else {
    // No torrentUrl — magnet only
    startSwarm(hash, ws, name);
    if (ws) relay(encodeRelay(hash, ws));
    else relay('_i ' + hash + ' -');
  }
}

// ── UI ───────────────────────────────────────────────────────
function buildUI() {
  if (document.getElementById('hs-root')) return;

  const style = document.createElement('style');
  style.textContent = `
  /* ── HiveStream v4.0 UI ── */
  #hs-root{
    width:100%;background:#080808;
    border:1px solid #1a1a1a;
    font-family:'Courier New',Courier,monospace;
    box-sizing:border-box;margin-bottom:8px;
  }
  #hs-toolbar{
    display:flex;align-items:center;gap:6px;padding:5px 8px;
    background:#0d0d0d;border-bottom:1px solid #1a1a1a;flex-wrap:wrap;
  }
  #hs-toolbar input{
    flex:1;min-width:140px;padding:4px 8px;
    background:#000;color:#39ff14;
    border:1px solid #1c1c1c;outline:none;
    font:12px 'Courier New',monospace;
  }
  #hs-toolbar input::placeholder{color:#2a2a2a;}
  #hs-toolbar input:focus{border-color:#39ff14;}
  .hs-btn{
    padding:4px 10px;background:#000;color:#39ff14;
    border:1px solid #1c1c1c;cursor:pointer;
    font:11px 'Courier New',monospace;white-space:nowrap;
    transition:all .15s;
  }
  .hs-btn:hover{background:#39ff14;color:#000;}
  .hs-btn.danger{color:#ff3939;border-color:#1c1c1c;}
  .hs-btn.danger:hover{background:#ff3939;color:#000;}
  #hs-state{
    font:10px 'Courier New',monospace;padding:2px 8px;
    border:1px solid #1c1c1c;color:#555;margin-left:auto;
    white-space:nowrap;
  }
  .hs-state-playing{color:#39ff14!important;border-color:#39ff14!important;}
  .hs-state-seeding{color:#39f!important;border-color:#39f!important;}
  .hs-state-buffering,.hs-state-metadata{color:#ff9939!important;border-color:#ff9939!important;}
  .hs-state-fetching{color:#999!important;}
  #hs-grid{
    display:flex;overflow-x:auto;gap:4px;padding:6px;
    background:#050505;scrollbar-width:thin;scrollbar-color:#1a1a1a #000;
  }
  #hs-grid:empty{display:none;}
  #hs-grid::-webkit-scrollbar{height:4px;}
  #hs-grid::-webkit-scrollbar-thumb{background:#1a1a1a;}
  .hs-thumb{
    cursor:pointer;flex-shrink:0;width:120px;
    border:1px solid #111;transition:border-color .15s;
    background:#0a0a0a;
  }
  .hs-thumb:hover{border-color:#39ff14;}
  .hs-thumb img{width:120px;height:67px;object-fit:cover;display:block;background:#111;}
  .hs-tlabel{
    color:#888;font:9px 'Courier New',monospace;
    padding:2px 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  }
  .hs-tlabel:hover{color:#39ff14;}
  .hs-tdur{color:#333;font:9px 'Courier New',monospace;padding:0 4px 3px;}
  #hs-vwrap{position:relative;background:#000;min-height:280px;}
  #hs-video{width:100%;display:block;min-height:280px;background:#000;}
  #hs-hud{
    position:absolute;top:6px;left:6px;
    background:rgba(0,0,0,.8);color:#39ff14;
    font:9px 'Courier New',monospace;padding:2px 6px;
    pointer-events:none;border:1px solid #1a1a1a;
  }
  #hs-overlay{
    position:absolute;inset:0;display:flex;
    align-items:center;justify-content:center;
    color:#222;font:13px 'Courier New',monospace;pointer-events:none;
  }

  /* ── Debug Console ── */
  #hs-debug{
    position:fixed;bottom:0;left:0;right:0;z-index:99999;
    background:rgba(0,0,0,.96);border-top:1px solid #1a1a1a;
    display:none;flex-direction:column;
  }
  #hs-dbtop{
    display:flex;align-items:center;gap:6px;
    padding:3px 8px;background:#050505;border-bottom:1px solid #111;
  }
  #hs-dbtop span{color:#333;font:10px 'Courier New',monospace;flex:1;}
  #hs-dbtop .hs-btn{font-size:9px;padding:2px 6px;}
  #hs-dblog{
    color:#39ff14;font:9px 'Courier New',monospace;
    padding:6px 8px;height:150px;overflow-y:auto;
    white-space:pre-wrap;word-break:break-all;
    scrollbar-width:thin;scrollbar-color:#1a1a1a #000;
  }
  #hs-dbtoggle{
    position:fixed;bottom:4px;right:4px;z-index:100000;
    background:#000;border:1px solid #1a1a1a;
    color:#333;font:9px 'Courier New',monospace;
    padding:3px 8px;cursor:pointer;
  }
  #hs-dbtoggle:hover{border-color:#39ff14;color:#39ff14;}
  `;
  document.head.appendChild(style);

  // ── Main theater div ──
  const root = document.createElement('div');
  root.id = 'hs-root';

  // Toolbar
  const tb = document.createElement('div');
  tb.id = 'hs-toolbar';
  tb.innerHTML =
    '<input id="hs-sinput" placeholder="search peertube…">' +
    '<button class="hs-btn" id="hs-sbtn">search</button>' +
    '<button class="hs-btn" id="hs-topbtn">top 10</button>' +
    '<button class="hs-btn danger" id="hs-stopbtn">stop</button>' +
    '<span id="hs-state" class="hs-state">○ idle</span>';
  root.appendChild(tb);

  // Thumbnail grid
  const grid = document.createElement('div');
  grid.id = 'hs-grid';
  root.appendChild(grid);

  // Video wrapper
  const vwrap = document.createElement('div');
  vwrap.id = 'hs-vwrap';

  const vid = document.createElement('video');
  vid.id = 'hs-video'; vid.controls = true; vid.autoplay = true; vid.playsInline = true;
  S.video = vid;
  vwrap.appendChild(vid);

  const hud = document.createElement('div');
  hud.id = 'hs-hud';
  vwrap.appendChild(hud);

  const overlay = document.createElement('div');
  overlay.id = 'hs-overlay';
  overlay.textContent = 'Nothing Playing — search or click Top 10';
  vwrap.appendChild(overlay);

  root.appendChild(vwrap);

  // Insert above #main
  const main = document.getElementById('main');
  if (main) main.parentNode.insertBefore(root, main);
  else document.body.prepend(root);

  // Wire buttons
  document.getElementById('hs-sbtn').onclick = function () {
    const v = document.getElementById('hs-sinput').value.trim();
    if (v) cmdSearch(v);
  };
  document.getElementById('hs-sinput').onkeydown = function (e) {
    if (e.key === 'Enter') { const v = e.target.value.trim(); if (v) cmdSearch(v); }
  };
  document.getElementById('hs-topbtn').onclick = cmdTop;
  document.getElementById('hs-stopbtn').onclick = function () { stopAll(true); };

  // ── Debug panel ──
  buildDebugPanel();

  log('UI built');
}

function buildDebugPanel() {
  const panel = document.createElement('div');
  panel.id = 'hs-debug';
  panel.innerHTML =
    '<div id="hs-dbtop">' +
    '<span>hivestream ' + V + ' debug</span>' +
    '<button class="hs-btn" id="hs-dbcopy">copy</button>' +
    '<button class="hs-btn" id="hs-dbclear">clear</button>' +
    '<button class="hs-btn" id="hs-dbstatus">status</button>' +
    '<button class="hs-btn" id="hs-dbclose">✕</button>' +
    '</div>' +
    '<pre id="hs-dblog"></pre>';
  document.body.appendChild(panel);

  const toggle = document.createElement('button');
  toggle.id = 'hs-dbtoggle';
  toggle.textContent = 'HS';
  document.body.appendChild(toggle);

  toggle.onclick = function () {
    const p = document.getElementById('hs-debug');
    p.style.display = p.style.display === 'flex' ? 'none' : 'flex';
  };
  document.getElementById('hs-dbclose').onclick = function () {
    document.getElementById('hs-debug').style.display = 'none';
  };
  document.getElementById('hs-dbclear').onclick = function () {
    dbLines.length = 0;
    const el = document.getElementById('hs-dblog');
    if (el) el.textContent = '';
  };
  document.getElementById('hs-dbcopy').onclick = function () {
    const txt = dbLines.join('\n');
    const btn = document.getElementById('hs-dbcopy');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt)
        .then(function () { btn.textContent = 'copied!'; setTimeout(function () { btn.textContent = 'copy'; }, 1500); })
        .catch(function () { fallbackCopy(txt, btn); });
    } else { fallbackCopy(txt, btn); }
  };
  document.getElementById('hs-dbstatus').onclick = dumpStatus;
}

function fallbackCopy(txt, btn) {
  const ta = document.createElement('textarea');
  ta.value = txt; ta.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); btn.textContent = 'copied!'; setTimeout(function () { btn.textContent = 'copy'; }, 1500); }
  catch (e) { warn('copy failed'); }
  document.body.removeChild(ta);
}

function dumpStatus() {
  const v = document.getElementById('hs-video');
  log('── STATUS ──');
  log('version:', V, '| state:', S.state);
  log('socket:', window.socket ? String(socket.connected) : 'none', '| name:', S.myName, '| rank:', S.myRank);
  log('coordinator:', isCoordinator());
  log('WT:', typeof WebTorrent, '| client:', S.wt ? 'exists' : 'null');
  log('torrent:', S.torrent ? S.torrent.name + ' peers=' + S.torrent.numPeers + ' pct=' + (S.torrent.length ? (S.torrent.downloaded / S.torrent.length * 100).toFixed(1) : '?') + '%' : 'null');
  log('video readyState:', v ? v.readyState : 'no el', '| src:', v ? v.src.slice(0, 80) : '—');
  log('results:', S.results.length, '| idb:', S.idb ? 'open' : 'closed');
}

function showGrid(items) {
  const grid = document.getElementById('hs-grid');
  if (!grid) return;
  grid.innerHTML = '';
  items.forEach(function (r, i) {
    const div = document.createElement('div');
    div.className = 'hs-thumb';
    const img = document.createElement('img');
    const host = r.account && r.account.host ? 'https://' + r.account.host : '';
    img.src = r.thumbnailUrl || (r.thumbnailPath ? host + r.thumbnailPath : '');
    img.onerror = function () { this.style.display = 'none'; };
    const label = document.createElement('div');
    label.className = 'hs-tlabel';
    label.title = r.name || '';
    label.textContent = (i + 1) + '. ' + (r.name || 'video');
    const dur = document.createElement('div');
    dur.className = 'hs-tdur';
    dur.textContent = fmtDur(r.duration) + (r.account && r.account.host ? ' · ' + r.account.host : '');
    div.appendChild(img); div.appendChild(label); div.appendChild(dur);
    div.onclick = function () { cmdPick(i + 1); };
    grid.appendChild(div);
  });
}

function setOverlay(txt) {
  const el = document.getElementById('hs-overlay');
  if (!el) return;
  el.style.display = txt ? 'flex' : 'none';
  el.textContent = txt;
}

// ── INDEXEDDB ────────────────────────────────────────────────
function openIDB() {
  if (!window.indexedDB) return;
  const r = indexedDB.open(CFG.idbName, CFG.idbVersion);
  r.onupgradeneeded = function (e) {
    const db = e.target.result;
    if (!db.objectStoreNames.contains('torrents'))
      db.createObjectStore('torrents');   // keyed by infoHash
    if (!db.objectStoreNames.contains('meta'))
      db.createObjectStore('meta');
  };
  r.onsuccess = function (e) {
    S.idb = e.target.result;
    log('IDB open:', CFG.idbName);
    autoSeedFromIDB();
  };
  r.onerror = function (e) { warn('IDB open error:', e.target.error); };
}

function idbStoreTorrent(t) {
  if (!S.idb || !t.torrentFile) return;
  try {
    const tx = S.idb.transaction('torrents', 'readwrite');
    tx.objectStore('torrents').put(t.torrentFile.buffer, t.infoHash);
    log('IDB stored:', t.infoHash);
  } catch (e) { warn('IDB store error:', e); }
}

function idbGetTorrent(hash, cb) {
  if (!S.idb) { cb(null); return; }
  try {
    const tx = S.idb.transaction('torrents', 'readonly');
    const req = tx.objectStore('torrents').get(hash);
    req.onsuccess = function () { cb(req.result || null); };
    req.onerror = function () { cb(null); };
  } catch (e) { cb(null); }
}

// Auto-seed any cached torrents when room loads
function autoSeedFromIDB() {
  if (!S.idb) return;
  try {
    const tx = S.idb.transaction('torrents', 'readonly');
    const req = tx.objectStore('torrents').getAllKeys();
    req.onsuccess = function () {
      const hashes = req.result || [];
      log('IDB cache:', hashes.length, 'torrent(s) available to seed');
      // Don't auto-add here — wait for _i relay so everyone syncs.
      // If seedOnly mode, add all cached torrents immediately.
      if (CFG.seedOnly && hashes.length) {
        hashes.forEach(function (hash) {
          idbGetTorrent(hash, function (buf) {
            if (!buf || !S.wt) return;
            try {
              const t = S.wt.add(new Uint8Array(buf));
              log('seedOnly: seeding', hash);
              t.on('error', function (e) { warn('seedOnly torrent error:', e.message); });
            } catch (e) { warn('seedOnly add error:', e.message); }
          });
        });
      }
    };
  } catch (e) { warn('IDB getAllKeys error:', e); }
}

// ── CHAT / COMMAND HOOK ──────────────────────────────────────
function hookChat() {
  if (!window.socket) { setTimeout(hookChat, 800); return; }
  socket.on('chatMsg', function (d) {
    const raw = (d.msg || '').trim();
    if (!raw.startsWith(CFG.cmd)) return;
    const body = decodeBody(raw.slice(CFG.cmd.length).trim());
    const parts = body.split(/\s+/);
    const cmd = parts[0] || '';
    const args = parts.slice(1);
    onCmd(d.username, cmd, args);
  });
  // Rank updates — server sends bare number
  socket.on('rank', function (r) { S.myRank = r; log('rank:', r); });
  socket.on('login', function (d) {
    if (d && d.name) { S.myName = d.name; if (d.rank !== undefined) S.myRank = d.rank; }
  });
  log('chat hooked');
}

function onCmd(sender, cmd, args) {
  // ── Internal relays (all clients process) ──
  // Ignore legacy relay types from old script versions (_m, _t)
  if (cmd === '_m' || cmd === '_t') {
    log('ignoring legacy relay:', cmd, '(old script version)');
    return;
  }
  if (cmd === '_i') {
    // _i <hash> <b64webseed>
    const { hash, ws } = decodeRelay(args[0] || '', args[1] || '-');
    log('relay _i hash=' + hash + ' ws=' + ws.slice(0, 60));
    if (S.state !== 'IDLE') { log('_i: not idle, ignoring'); return; }
    startSwarm(hash, ws || null, null);
    return;
  }
  if (cmd === '_s') { applySync(parseFloat(args[0])); return; }

  // ── Public commands ──
  if (cmd === 'help') { cmdHelp(); return; }
  if (cmd === 'status') { dumpStatus(); cmdStatus(); return; }
  if (cmd === 'info') { cmdInfo(parseInt(args[0])); return; }
  if (cmd === 'stop') { stopAll(false); return; }

  // ── Coordinator or sender commands ──
  if (cmd === 'search') { if (sender === S.myName) cmdSearch(args.join(' ')); return; }
  if (cmd === 'top') { if (sender === S.myName) cmdTop(); return; }
  if (cmd === 'pick') {
    if (sender === S.myName) { const n = parseInt(args[0]); if (!isNaN(n)) cmdPick(n); }
    return;
  }
  if (/^[0-9a-f]{40}$/i.test(cmd)) {
    if (sender === S.myName) cmdPickHash(cmd.toLowerCase());
    return;
  }
  if (cmd === 'sync') {
    if (sender === S.myName && S.video) relay('_s ' + S.video.currentTime.toFixed(2));
    return;
  }
  if (cmd === 'seek') {
    if (sender === S.myName) { const t = parseFloat(args[0]); if (!isNaN(t)) relay('_s ' + t.toFixed(2)); }
    return;
  }
}

function cmdHelp() {
  chat('HiveStream v' + V + ': top | search <q> | pick <n> | info <n> | <hash> | sync | seek <s> | stop | status');
}

function cmdStatus() {
  if (!S.torrent) { chat('HiveStream v' + V + ': ' + S.state); return; }
  const t = S.torrent;
  const pct = t.length ? (t.downloaded / t.length * 100).toFixed(1) : '?';
  chat(S.state + ' · ' + pct + '% · ' + t.numPeers + 'p · ' + fmtSpd(t.downloadSpeed) + '▼ ' + fmtSpd(t.uploadSpeed) + '▲');
}

function cmdInfo(n) {
  const v = S.results[n - 1];
  if (!v) { chat('No result ' + n + '. Run !hs top or search first.'); return; }
  const h = v.account && v.account.host || '?';
  chat('[' + n + '] ' + v.name + ' | ' + fmtDur(v.duration) + ' | ' + h);
}

// ── IDENTITY ─────────────────────────────────────────────────
function detectSelf() {
  try {
    if (window.CLIENT) {
      S.myName = CLIENT.name || '';
      S.myRank = CLIENT.rank !== undefined ? CLIENT.rank : -1;
    }
  } catch (e) {}
  if (!S.myName) {
    const w = document.getElementById('welcome');
    if (w) S.myName = w.textContent.replace(/^Welcome,\s*/i, '').trim();
  }
  log('identity: name=' + S.myName + ' rank=' + S.myRank + ' coordinator=' + isCoordinator());
}

// ── UTILS ────────────────────────────────────────────────────
function fmtDur(s) {
  if (!s || isNaN(s)) return '?';
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return m + ':' + (sec < 10 ? '0' : '') + sec;
}

function fmtSpd(b) {
  if (b > 1e6) return (b / 1e6).toFixed(1) + 'MB/s';
  if (b > 1e3) return (b / 1e3).toFixed(0) + 'KB/s';
  return (b || 0) + 'B/s';
}

// ── WINDOW ERROR HOOKS ───────────────────────────────────────
function hookErrors() {
  window.addEventListener('error', function (e) {
    dbWrite('E', ['UNCAUGHT: ' + e.message + ' @ ' + e.filename + ':' + e.lineno]);
  });
  window.addEventListener('unhandledrejection', function (e) {
    dbWrite('E', ['UNHANDLED PROMISE: ' + (e.reason && e.reason.message ? e.reason.message : String(e.reason))]);
  });
}

// ── BOOT ─────────────────────────────────────────────────────
function boot() {
  log('v' + V + ' booting');
  hookErrors();

  // Load WebTorrent from CDN
  loadScript('https://cdn.jsdelivr.net/npm/webtorrent@1/webtorrent.min.js', function () {
    log('WebTorrent loaded');
    S.wt = mkClient();
    detectSelf();
    openIDB();
    if (!CFG.seedOnly) buildUI();
    hookChat();
    chat('HiveStream v' + V + ' ready — type !hs help');
    log('boot complete — coordinator:', isCoordinator());
  });
}

function loadScript(src, cb) {
  if (document.querySelector('script[src="' + src + '"]')) { cb(); return; }
  const s = document.createElement('script');
  s.src = src;
  s.onload = cb;
  s.onerror = function () { errlog('CDN load failed:', src); cb(); };
  document.head.appendChild(s);
}

// ── GO ───────────────────────────────────────────────────────
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

})();
