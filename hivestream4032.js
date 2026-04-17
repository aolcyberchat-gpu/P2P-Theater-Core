// ============================================================
// HiveStream v4.0.32
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

const V = '4.0.32';
if (window.__HS === V) return;
window.__HS = V;

// ── CONFIG ───────────────────────────────────────────────────
const CFG = {
  cmd:        '!hs',
  seedOnly:   false,
  syncThres:  2.5,
  syncMs:     30000,
  chatBurst:  20,
  chatDelay:  100,

  trackers: [
    'wss://tracker.openwebtorrent.com',
    'wss://tracker.webtorrent.dev',
    'wss://tracker.webtorrent.io',
    'wss://tracker.btorrent.xyz',
    'wss://tracker.fastcast.nz',
    'wss://tracker.novage.com.ua',
    'wss://tracker.opentrackr.org:1337/announce',
    'wss://tracker.files.fm:7073/announce',
    'wss://peertube.cpy.re:443/tracker/socket',
    'wss://framatube.org:443/tracker/socket',
    'wss://tube.privacytools.io:443/tracker/socket',
    'wss://peertube.social:443/tracker/socket',
    'wss://video.ploud.fr:443/tracker/socket',
    'wss://tracker.dler.com:6969/announce',
    'wss://tracker.sloppyta.co:443/announce',
    'wss://tracker.lab.bg:443/announce',
    'wss://tracker.qu.ax:443/announce',
    'wss://wstracker.online',
    'wss://tracker.uw0.xyz:443/announce',
  ],

  searchApi: 'https://sepiasearch.org/api/v1/search/videos',
  topApi:    'https://framatube.org/api/v1/videos?sort=-trending&count=20&hasWebtorrentVideo=true',

  // Archive.org search API — no CORS, no auth, direct MP4 URLs always work
  archiveApi: 'https://archive.org/advancedsearch.php',

  // Known CORS-blocking PeerTube instances — fileUrl from these won't play cross-origin.
  // Extend this list as we discover more. SepiaSearch results from these are skipped.
  // Known HLS-only or CORS-blocking PeerTube instances.
  // Results from these are filtered from search — saves user from picking
  // a video that will show "no WebTorrent files" error.
  // Add instances here as discovered. Check with: curl -s https://<host>/api/v1/config | jq .transcoding
  corsBlocklist: [
    // Confirmed HLS-only (WebTorrent disabled in instance config)
    'peertube.opencloud.lu',
    'video.lqdn.fr',
    'tube.extinctionrebellion.fr',
    'peertube.datagueule.tv',
    'tube.hoga.fr',
    'media.fsfe.org',
    'tilvids.com',           // confirmed HLS-only from search results
    'peertube.tv',
    'videos.lukesmith.xyz',
    'makertube.net',         // mixed but often HLS-only
    // CORS-blocking (has WebTorrent but blocks cross-origin video requests)
    // Add as discovered during testing
  ],

  idbName:    'HiveStream4',
  idbVersion: 2,  // bumped to clear stale torrent data from v1
};

// ── KNOWN HASHES ────────────────────────────────────────────
const KNOWN = {
  'dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c': {
    name: 'Big Buck Bunny',
    torrentUrl: 'https://webtorrent.io/torrents/big-buck-bunny.torrent',
    // Archive.org H.264 is primary — confirmed working on Verizon mobile.
    // Google CDN and Blender fail on Verizon. Archive.org fallbacks are tried in order.
    ws: 'https://archive.org/download/BigBuckBunny_124/Content/big_buck_bunny_720p_surround.mp4',
    wsFallbacks: [
      'https://archive.org/download/BigBuckBunny/BigBuckBunny.mp4',
      'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
    ],
  },
  '08ada5a7a6183aae1e09d831df6748d566095a10': {
    name: 'Sintel',
    torrentUrl: 'https://webtorrent.io/torrents/sintel.torrent',
    ws: 'https://archive.org/download/Sintel/sintel-2048-surround.mp4',
    wsFallbacks: [
      'https://archive.org/download/Sintel_blender/sintel-1024-surround.mp4',
    ],
  },
  'a88fda5954e89178c372716a6a78b8180ed4dad3': {
    name: 'Tears of Steel',
    torrentUrl: 'https://webtorrent.io/torrents/tears-of-steel.torrent',
    ws: 'https://archive.org/download/tears-of-steel/tears_of_steel_1080p.mp4',
    wsFallbacks: [
      'https://archive.org/download/tears-of-steel/tears_of_steel_720p.mp4',
    ],
  },
  '6a9759bffd5c0af65319979fb7832189f4f3c35d': {
    name: 'Elephants Dream',
    torrentUrl: 'https://webtorrent.io/torrents/elephants-dream.torrent',
    ws: 'https://archive.org/download/ElephantsDream/ed_1024_512kb.mp4',
    wsFallbacks: [
      'https://archive.org/download/ElephantsDream/ed_hd.avi',
    ],
  },

  // ── Small files under 200MB — these use renderTo() for TRUE P2P playback ──
  // renderTo() streams pieces directly into the video element via MediaSource API.
  // No HTTP to any server during playback. Pieces come from WebRTC peers.

  // Cosmos Laundromat (Blender, 2015) — 12min short film, ~180MB fMP4
  // Specifically encoded for browser WebTorrent — confirmed fragmented MP4
  'c9e15763f722f23e98a29decdfae341b98d53056': {
    name: 'Cosmos Laundromat',
    torrentUrl: 'https://webtorrent.io/torrents/cosmos-laundromat.torrent',
    ws: 'https://archive.org/download/CosmosLaundromat/Cosmos_Laundromat_1080p.mp4',
    wsFallbacks: [],
  },

  // Sintel (Blender, 2010) — 15min short film, ~130MB fMP4
  'e1e75eedb2e609e7aa38bf0a4b5e24c3a524c096': {
    name: 'Sintel (HD)',
    torrentUrl: 'https://webtorrent.io/torrents/sintel.torrent',
    ws: 'https://archive.org/download/Sintel/sintel-2048-surround.mp4',
    wsFallbacks: [
      'https://archive.org/download/Sintel/sintel-1024-surround.mp4',
    ],
  },

  // Night of the Living Dead (1968) — public domain, archive.org
  // ~700MB so will use HTTP, but good test of archive.org streaming
  // Use !hs search archive:night of the living dead instead for better results
};


// Instances confirmed to have WebTorrent files AND allow CORS on fileUrl
const WEBTORRENT_INSTANCES = [
  'tube.tchncs.de',
  'peertube.dsmouse.net',
  'framatube.org',
  'video.blendertube.de',
  'peertube.cpy.re',
  'peertube.social',
  'toobnix.org',
  'videos.danksquad.org',
  'share.tube',
  'video.rastapuls.com',
  'kolektiva.media',
  'spectra.video',
  'koreus.tv',
  'cuddly.tube',
];
// ── STATE ────────────────────────────────────────────────────
const S = {
  state:   'IDLE',
  wt:      null,
  torrent: null,
  video:   null,
  results: [],
  myName:  '',
  myRank:  -1,
  chatQueue:  [],
  chatTimer:  null,
  chatCount:  0,
  chatReset:  null,
  syncTimer: null,
  idb: null,
  videoAttached: false,
  activeWs: null,
  errorHandled: false,  // set by onerror to suppress play().catch overlay
  renderToTimer: null,  // detects fMP4 stall and switches to HTTP
  playbackSource: 'P2P',  // 'P2P' or 'HTTP:<domain>' — shown in HUD
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
  // CHATTHROTTLE is CyTube's internal rate-limit flag — if true, message will be dropped
  if (window.CHATTHROTTLE) {
    S.chatTimer = setTimeout(flushChat, 300);
    return;
  }
  socket.emit('chatMsg', { msg: S.chatQueue.shift() });
  S.chatCount++;
  const delay = S.chatCount < CFG.chatBurst ? 150 : CFG.chatDelay;
  S.chatTimer = setTimeout(flushChat, delay);
}

function relay(body) { chat(CFG.cmd + ' ' + body); }

// ── RELAY ENCODER/DECODER ────────────────────────────────────
function encodeRelay(hash, wsUrl) {
  const b64 = btoa(wsUrl).replace(/=/g, '');
  return '_i ' + hash + ' ' + b64;
}

function decodeRelay(hashArg, b64Arg) {
  const hash = (hashArg || '').toLowerCase();
  let ws = '';
  if (!b64Arg || b64Arg === '-' || b64Arg === 'none' || b64Arg === 'null') {
    return { hash, ws: '' };
  }
  try {
    const pad = b64Arg.length % 4;
    const padded = pad ? b64Arg + '='.repeat(4 - pad) : b64Arg;
    ws = atob(padded);
  } catch (e) {
    warn('base64 decode failed:', e.message);
  }
  return { hash, ws };
}

function decodeBody(body) {
  if (!body) return body;
  let s = body;
  if (s.indexOf('<') >= 0) {
    s = s.replace(/<a[^>]+href="([^"]*)"[^>]*>[^<]*<\/a>/gi, function (_, href) { return href; });
    s = s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }
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
function isCoordinator() {
  // CyTube's CLIENT.leader flag is the most reliable coordinator signal —
  // it's set server-side when setLeader is emitted. Check it first.
  if (window.CLIENT && CLIENT.leader === true) return true;
  // Rank-based fallback: highest rank in room is coordinator
  if (S.myRank < 1.5) return false;
  const items = Array.from(document.querySelectorAll('#userlist .userlist_item'));
  if (!items.length) return true;
  let highestOther = 0;
  items.forEach(function (el) {
    const sp = el.querySelector('span:nth-child(2)');
    const name = sp ? sp.textContent.trim() : '';
    if (!name || name === S.myName) return;
    // Use confirmed CSS class names from CyTube source (callbacks.js line 455-459):
    // userlist_guest=0, userlist_op=2(mod), userlist_owner=3(admin), userlist_siteadmin=255
    const c = (el.className || '') + (sp ? (sp.className || '') : '');
    let r = 1;
    if (c.includes('userlist_siteadmin')) r = 255;
    else if (c.includes('userlist_owner')) r = 3;
    else if (c.includes('userlist_op')) r = 2;
    if (r > highestOther) highestOther = r;
  });
  return S.myRank >= highestOther;
}

// ── WEBTORRENT CLIENT ────────────────────────────────────────
function mkClient() {
  const wt = new window.WebTorrent({
    // Extend ICE server list beyond WebTorrent's default (Google + Twilio only).
    // More STUN servers = better NAT traversal, especially for Verizon mobile.
    // No TURN available in browser WebTorrent — symmetric NAT peers won't connect
    // via WebRTC but will still get pieces via webseed HTTP.
    tracker: {
      rtcConfig: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          { urls: 'stun:stun2.l.google.com:19302' },
          { urls: 'stun:global.stun.twilio.com:3478' },
          { urls: 'stun:stun.stunprotocol.org:3478' },
          { urls: 'stun:stun.ekiga.net' },
        ]
      }
    }
  });
  wt.on('error', function (e) { errlog('WT client:', e.message || e); });
  return wt;
}

function startSwarmThenRelay(hash, ws, dn) {
  if (S.state !== 'IDLE') { log('startSwarmThenRelay: not IDLE, ignoring'); return; }
  if (!S.wt) S.wt = mkClient();
  S.activeWs = ws || null;

  // KEY DESIGN: If we have a webseed URL, start HTTP playback immediately.
  // Don't wait for torrent metadata — all WSS trackers may be down, which
  // would block the video forever. HTTP playback is reliable and instant.
  // WebTorrent runs in background: once it gets metadata (from any peer),
  // it becomes a seeder and other room users can pull pieces via WebRTC.
  if (ws) {
    log('webseed available — starting HTTP playback immediately');
    transition('BUFFERING');
    // Relay to room immediately with the webseed URL
    relay(encodeRelay(hash, ws));
    // Start video
    attachVideo(null, ws);
    startSyncTimer();
    const el = document.getElementById('currenttitle');
    if (el) el.textContent = dn || hash.slice(0, 8);
    // Start WebTorrent in background for P2P seeding — non-blocking
    idbGetTorrent(hash, function (cachedBuf) {
      const magnet = buildMagnet(hash, ws, dn);
      let t;
      try {
        t = cachedBuf ? S.wt.add(new Uint8Array(cachedBuf), { announce: CFG.trackers }) : S.wt.add(magnet);
      } catch (e) {
        t = S.wt.get(hash);
        if (!t) { warn('background wt.add failed:', e.message); return; }
      }
      S.torrent = t;
      // Bind torrent for seeding + IDB storage — but don't attach video again
      t.on('metadata', function () {
        log('background metadata:', t.name, '— now seeding to peers');
        if (t.pieces && t.pieces.length > 0) {
          const critEnd = Math.max(0, Math.floor(t.pieces.length * 0.05) - 1);
          try { t.critical(0, critEnd); } catch(e) {}
        }
        startHUD(t);
      });
      t.on('done', function () {
        log('background done — seeding:', t.name);
        transition('SEEDING');
        idbStoreTorrent(t);
        chat('Seeding "' + (t.name || dn) + '" to room');
      });
      t.on('wire', function (wire) {
        log('peer connected:', wire.remoteAddress || 'webrtc', '— total:', t.numPeers);
      });
      t.on('warning', function (w) { warn('torrent:', w.message || w); });
      t.on('error', function (e) {
        const msg = e.message || String(e);
        if (msg.indexOf('duplicate') >= 0) return;
        warn('background torrent error:', msg);
      });
    });
    return;
  }

  // No webseed — must wait for torrent metadata to know what file to play
  transition('METADATA');
  idbGetTorrent(hash, function (cachedBuf) {
    const magnet = buildMagnet(hash, ws, dn);
    let t;
    try {
      t = cachedBuf ? S.wt.add(new Uint8Array(cachedBuf), { announce: CFG.trackers }) : S.wt.add(magnet);
    } catch (e) {
      t = S.wt.get(hash);
      if (!t) { errlog('startSwarmThenRelay add failed:', e.message); transition('IDLE'); return; }
    }
    S.torrent = t;
    relay('_i ' + hash + ' -');
    bindTorrent(t);
  });
}

function startSwarm(hash, ws, dn) {
  if (S.state !== 'IDLE') {
    log('startSwarm: not IDLE (state=' + S.state + '), ignoring');
    return;
  }
  if (!S.wt) S.wt = mkClient();
  transition('METADATA');

  idbGetTorrent(hash, function (cachedBuf) {
    const magnet = buildMagnet(hash, ws, dn);
    S.activeWs = ws || null;  // store for attachVideo
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
    // Mark first 5% of pieces as critical — fetched before all others for fast start
    if (t.pieces && t.pieces.length > 0) {
      const critEnd = Math.max(0, Math.floor(t.pieces.length * 0.05) - 1);
      try { t.critical(0, critEnd); log('critical 0-' + critEnd + '/' + t.pieces.length); }
      catch (e) {}
    }
    transition('BUFFERING');
    chat('"' + t.name + '" — buffering…');
    const el = document.getElementById('currenttitle');
    if (el) el.textContent = t.name;
    attachVideo(t, S.activeWs);
    startHUD(t);
    startSyncTimer();
  });

  t.on('ready', function () {
    log('ready:', t.name);
    transition('PLAYING');
    chat('"' + t.name + '" ready — ' + t.numPeers + ' peer(s)');
    log('ready — paused=' + (S.video ? S.video.paused : '?') + ' readyState=' + (S.video ? S.video.readyState : '?') + ' src=' + (S.video && S.video.src ? 'set' : 'empty'));
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
    if (msg.indexOf('duplicate') >= 0 && t.infoHash) {
      const existing = S.wt.get(t.infoHash);
      if (existing && existing !== t) {
        log('duplicate recovery: rebinding to existing torrent', t.infoHash);
        S.torrent = existing;
        if (existing.files && existing.files.length) {
          transition('BUFFERING');
          attachVideo(existing, S.activeWs); startHUD(existing); startSyncTimer();
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

function attachVideo(t, wsUrl) {
  if (S.videoAttached) { log('attachVideo: already attached, skipping'); return; }
  S.videoAttached = true;

  const overlay = document.getElementById('hs-overlay');
  if (overlay) overlay.style.display = 'none';

  // t may be null when called from webseed-only path (PeerTube picks with fileUrl)
  // In that case skip renderTo and go straight to HTTP
  if (!t) {
    if (wsUrl) { log('no torrent, HTTP direct:', wsUrl.slice(0, 80)); httpFallback(wsUrl); }
    else { errlog('attachVideo: no torrent and no wsUrl'); }
    return;
  }

  // Find best playable file
  const PLAYABLE = /\.(mp4|webm|mkv|mov|ogv|ogg|m4v)$/i;
  let best = null;
  t.files.forEach(function (f) {
    if (!best) { best = f; return; }
    const fv = PLAYABLE.test(f.name), bv = PLAYABLE.test(best.name);
    if (fv && !bv) { best = f; return; }
    if (f.length > best.length) best = f;
  });

  if (!best) {
    errlog('no playable file in torrent');
    if (wsUrl) httpFallback(wsUrl);
    return;
  }

  // WebTorrent Blob URL approach has a 200MB limit on mobile browsers.
  // Files larger than this will always fail renderTo immediately.
  // Skip straight to HTTP for large files.
  const BLOB_LIMIT = 200 * 1024 * 1024; // 200MB
  if (best.length > BLOB_LIMIT) {
    log('file too large for renderTo (' + Math.round(best.length/1e6) + 'MB > 200MB limit) — going direct HTTP');
    if (wsUrl) httpFallback(wsUrl);
    else { setOverlay('Seeding only — no direct play link. Desktop users: file will play via P2P.'); log('no webseed, seeding only'); S.videoAttached = false; }
    return;
  }

  log('P2P renderTo attempt:', best.name, '(' + Math.round(best.length / 1e6) + 'MB)');
  setOverlay('P2P streaming…');

  // One-shot error flag — prevents the infinite loop where renderTo error
  // triggers httpFallback which sets new onerror which fires again
  var errorFired = false;

  S.video.onplaying = function () {
    log('P2P playing readyState=' + S.video.readyState);
    S.playbackSource = 'P2P';
    setOverlay('');
    hideTapOverlay();
    if (S.renderToTimer) { clearTimeout(S.renderToTimer); S.renderToTimer = null; }
  S.playbackSource = 'P2P';
  };
  S.video.oncanplay = function () {
    log('canplay paused=' + S.video.paused + ' readyState=' + S.video.readyState);
    if (S.video.paused && S.video.currentTime < 0.5) showTapOverlay();
  };
  S.video.onerror = function () {
    if (errorFired) return; // prevent infinite loop
    errorFired = true;
    const msg = S.video.error ? S.video.error.message : 'unknown';
    errlog('video error during P2P:', msg);
    if (S.renderToTimer) { clearTimeout(S.renderToTimer); S.renderToTimer = null; }
  S.playbackSource = 'P2P';
    // Fully detach from video element before switching to HTTP
    S.video.onerror = null;
    S.video.onplaying = null;
    S.video.oncanplay = null;
    S.video.removeAttribute('src');
    S.video.load();
    if (wsUrl) {
      warn('P2P failed — switching to HTTP');
      httpFallback(wsUrl);
    } else {
      setOverlay('Playback failed. Try !hs stop.');
      if (S.state !== 'IDLE') transition('IDLE');
    }
  };

  best.renderTo(S.video, function (err) {
    if (err) {
      if (errorFired) return;
      errorFired = true;
      errlog('renderTo error:', err.message);
      S.videoAttached = false;
      S.video.onerror = null;
      S.video.onplaying = null;
      S.video.oncanplay = null;
      if (wsUrl) httpFallback(wsUrl);
      return;
    }
    log('renderTo attached readyState=' + S.video.readyState);

    // If readyState stays ≤1 for 8s: regular (non-fragmented) MP4 — switch to HTTP
    if (S.renderToTimer) clearTimeout(S.renderToTimer);
    S.renderToTimer = setTimeout(function () {
      S.renderToTimer = null;
      if (errorFired) return;
      if (S.video.readyState <= 1 && S.video.paused) {
        warn('renderTo stalled readyState=' + S.video.readyState + ' — not fMP4, HTTP fallback');
        errorFired = true;
        S.video.onerror = null;
        S.video.onplaying = null;
        S.video.oncanplay = null;
        if (wsUrl) httpFallback(wsUrl);
        else { setOverlay('Cannot play this format. Try !hs stop.'); transition('IDLE'); }
      } else {
        log('P2P mode active readyState=' + S.video.readyState);
      }
    }, 8000);
  });
}

function httpFallback(wsUrl) {
  log('HTTP fallback:', wsUrl.slice(0, 80));
  // Extract domain for HUD display
  try { S.playbackSource = 'HTTP:' + new URL(wsUrl).hostname; } catch(e) { S.playbackSource = 'HTTP'; }
  setOverlay('');
  var fallbacks = [];
  if (S.torrent && S.torrent.infoHash) {
    var k = KNOWN[S.torrent.infoHash];
    if (k && k.wsFallbacks) fallbacks = k.wsFallbacks.slice();
  }
  playDirect(wsUrl, fallbacks);
}


function playDirect(url, fallbacks) {
  S.errorHandled = false;
  wireVideoEvents(url, fallbacks || []);
  S.video.src = url;
  S.video.load();
  log('trying URL:', url.slice(0, 90));
  const p = S.video.play();
  if (p && typeof p.then === 'function') {
    p.then(function () {
      log('direct play started');
    }).catch(function (e) {
      // If onerror already handled this (Format error etc), don't show tap overlay again
      if (S.errorHandled) { log('play() catch suppressed — onerror already handled'); return; }
      log('direct play blocked (' + e.message + ') — showing tap overlay');
      showTapOverlay();
    });
  }
}

function wireVideoEvents(currentUrl, fallbacks) {
  S.video.onplaying = function () {
    log('video playing readyState=' + S.video.readyState);
    // Update source label for HUD — extract domain from current URL
    if (currentUrl) {
      try { S.playbackSource = 'HTTP:' + new URL(currentUrl).hostname.replace('www.',''); }
      catch(e) { S.playbackSource = 'HTTP'; }
    }
    // Transition to PLAYING if still in BUFFERING
    if (S.state === 'BUFFERING' || S.state === 'METADATA') transition('PLAYING');
    hideTapOverlay();
  };
  // Debounced canplay — fires many times during HTTP buffer refills.
  // Only show tap overlay if video is genuinely paused for > 800ms, not a buffer flash.
  var canplayDebounce = null;
  S.video.oncanplay = function () {
    if (canplayDebounce) clearTimeout(canplayDebounce);
    canplayDebounce = setTimeout(function () {
      canplayDebounce = null;
      if (S.video && S.video.paused && S.video.readyState >= 3) {
        log('canplay: video paused after buffer — showing tap overlay');
        showTapOverlay();
      }
    }, 800);
  };
  S.video.onerror = function () {
    const err = S.video.error;
    const msg = err ? err.message : 'unknown error';
    const code = err ? err.code : 0;
    errlog('video error code=' + code + ':', msg);
    S.errorHandled = true;

    // Auto-retry with next fallback URL before giving up
    if (fallbacks && fallbacks.length > 0) {
      const next = fallbacks[0];
      const rest = fallbacks.slice(1);
      warn('URL failed, trying fallback:', next.slice(0, 80));
      chat('⚠ URL failed — trying fallback…');
      S.video.removeAttribute('src');
      S.video.load();
      S.errorHandled = false;
      wireVideoEvents(next, rest);
      S.video.src = next;
      S.video.load();
      const p = S.video.play();
      if (p && typeof p.then === 'function') {
        p.then(function () { log('fallback play started'); })
         .catch(function (e) {
           if (!S.errorHandled) {
             log('fallback play blocked:', e.message);
             showTapOverlay();
           }
         });
      }
      return;
    }

    // All URLs exhausted — reset and tell user
    S.video.removeAttribute('src');
    S.video.load();
    S.videoAttached = false;
    const hint = 'All URLs failed (' + msg + '). Try !hs stop and pick another video.';
    setOverlay(hint);
    chat('⚠ ' + hint);
    if (S.state !== 'IDLE') transition('IDLE');
  };
}


function showTapOverlay() {
  const old = document.getElementById('hs-tap');
  if (old) old.remove();
  const tap = document.createElement('div');
  tap.id = 'hs-tap';
  tap.style.cssText =
    'position:absolute;inset:0;display:flex;flex-direction:column;' +
    'align-items:center;justify-content:center;cursor:pointer;z-index:10;' +
    'background:rgba(0,0,0,0.55);';
  tap.innerHTML =
    '<div style="font-size:64px;line-height:1;text-shadow:0 0 30px #39ff14">▶</div>' +
    '<div style="color:#39ff14;font:13px Courier New,monospace;margin-top:8px">tap to play</div>';
  tap.onclick = function () {
    // Muted play bypasses all autoplay/power-saving restrictions.
    // onplaying handler in attachVideo will call hideTapOverlay + showUnmuteBtn.
    S.video.muted = true;
    const p = S.video.play();
    if (p && typeof p.then === 'function') {
      p.catch(function (e) { errlog('tap play() failed:', e.message); });
    }
  };
  const vwrap = document.getElementById('hs-vwrap');
  if (vwrap) vwrap.appendChild(tap);
}

function hideTapOverlay() {
  const el = document.getElementById('hs-tap');
  if (el) el.remove();
}

// Unmute button — shown after muted autoplay succeeds.
// Small, unobtrusive, disappears after unmuting.
function showUnmuteBtn() {
  if (document.getElementById('hs-unmute')) return;
  const btn = document.createElement('button');
  btn.id = 'hs-unmute';
  btn.textContent = '🔇 tap to unmute';
  btn.style.cssText =
    'position:absolute;bottom:40px;left:50%;transform:translateX(-50%);' +
    'background:rgba(0,0,0,0.8);color:#39ff14;border:1px solid #39ff14;' +
    'font:12px Courier New,monospace;padding:6px 16px;cursor:pointer;z-index:11;' +
    'border-radius:3px;';
  btn.onclick = function () {
    S.video.muted = false;
    btn.remove();
    log('unmuted by user');
  };
  const vwrap = document.getElementById('hs-vwrap');
  if (vwrap) vwrap.appendChild(btn);
}

// ── HUD ──────────────────────────────────────────────────────
function startHUD(t) {
  if (S.hudTimer) clearInterval(S.hudTimer);
  S.hudTimer = setInterval(function () {
    if (!S.torrent && !t) { clearInterval(S.hudTimer); S.hudTimer = null; return; }
    const _t = S.torrent || t;
    const pct = _t.length ? (_t.downloaded / _t.length * 100).toFixed(1) : '?';
    const spd = fmtSpd(_t.downloadSpeed) + '▼ ' + fmtSpd(_t.uploadSpeed) + '▲';
    const src = S.playbackSource || 'P2P';
    const txt = '[' + src + '] ' + pct + '% · ' + _t.numPeers + 'p · ' + spd;
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
  S.videoAttached = false;
  S.activeWs = null;
  S.errorHandled = false;
  if (S.renderToTimer) { clearTimeout(S.renderToTimer); S.renderToTimer = null; }
  S.playbackSource = 'P2P';
  if (S.video) {
    S.video.onplaying = null; S.video.oncanplay = null; S.video.onerror = null;
    S.video.pause();
    S.video.removeAttribute('src');
    S.video.load();
  }
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
// ── ARCHIVE.ORG SEARCH ──────────────────────────────────────
// Returns direct MP4 URLs — no CORS, no WebTorrent needed, always works.
// Query hits Internet Archive's full-text search across millions of items.
function cmdArchive(q) {
  if (!isCoordinator()) { chat('Only the coordinator can search.'); return; }
  if (S.state !== 'IDLE') { chat('Stop current video first: !hs stop'); return; }
  transition('FETCHING');
  setOverlay('Searching Archive.org…');
  // mediatype:movies finds video items; output=json for API response
  const url = CFG.archiveApi + '?q=' + encodeURIComponent(q + ' AND mediatype:movies') +
    '&fl[]=identifier,title,description&sort[]=downloads+desc&rows=20&output=json';
  fetch(url)
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (d) {
      transition('IDLE');
      const docs = (d.response && d.response.docs) || [];
      if (!docs.length) { chat('No Archive.org results for: ' + q); setOverlay('Nothing Playing'); return; }
      // Store as results with a flag so cmdPick knows to use archive path
      S.results = docs.map(function (doc) {
        return {
          _archive: true,
          identifier: doc.identifier,
          name: doc.title || doc.identifier,
          duration: 0,
          account: { host: 'archive.org' },
        };
      });
      showGrid(S.results);
      chat(S.results.length + ' Archive.org results for "' + q + '":');
      S.results.slice(0, 8).forEach(function (v, i) {
        chat((i + 1) + '. ' + v.name + ' (archive.org)');
      });
    })
    .catch(function (e) {
      transition('IDLE');
      setOverlay('Nothing Playing');
      chat('Archive search error: ' + e.message);
    });
}

// Fetch the best MP4 file from an Archive.org item
function archivePick(item) {
  transition('FETCHING');
  setOverlay('Fetching from Archive.org…');
  fetch('https://archive.org/metadata/' + item.identifier)
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (meta) {
      transition('IDLE');
      const files = (meta.files || []).filter(function (f) {
        return /\.mp4$/i.test(f.name) && f.source !== 'derivative';
      });
      // Prefer original mp4, fallback to any mp4
      const all = (meta.files || []).filter(function (f) { return /\.mp4$/i.test(f.name); });
      const target = files[0] || all[0];
      if (!target) { chat('No MP4 found in: ' + item.identifier); setOverlay('Nothing Playing'); return; }
      const url = 'https://archive.org/download/' + item.identifier + '/' + target.name;
      chat('Playing: "' + item.name + '" from Archive.org');
      setOverlay('Connecting…');
      S.activeWs = url;
      // No WebTorrent for archive items — pure HTTP play
      // Still need a fake torrent state so UI works correctly
      transition('BUFFERING');
      // Archive.org files are regular (non-fragmented) MP4 — skip renderTo, go direct HTTP
      playDirect(url, []);
      transition('PLAYING');
      const el = document.getElementById('currenttitle');
      if (el) el.textContent = item.name;
    })
    .catch(function (e) {
      transition('IDLE');
      setOverlay('Nothing Playing');
      chat('Archive fetch error: ' + e.message);
    });
}

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

  // Check if query starts with 'archive:' — route to Archive.org search
  if (q.toLowerCase().startsWith('archive:')) {
    cmdArchive(q.slice(8).trim());
    return;
  }

  transition('FETCHING');
  setOverlay('Searching PeerTube…');
  // SepiaSearch valid sort: -match, -likes, -views, -publishedAt, -trending
  const url = CFG.searchApi + '?search=' + encodeURIComponent(q) + '&count=40&sort=-views&nsfw=false';
  fetch(url)
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (d) {
      transition('IDLE');
      // Filter out known CORS-blocking instances
      const all = d.data || [];
      const filtered = all.filter(function (v) {
        const host = v.account && v.account.host ? v.account.host : '';
        return !CFG.corsBlocklist.includes(host);
      });
      S.results = filtered;
      if (!S.results.length) {
        chat('No playable results for: ' + q + ' (try: !hs search archive:' + q + ')');
        setOverlay('Nothing Playing');
        return;
      }
      showGrid(S.results);
      chat(S.results.length + ' results for "' + q + '" (filtered ' + (all.length - filtered.length) + ' CORS-blocked):');
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
  // Reject if already loading or playing — prevents multiple concurrent picks
  if (S.state !== 'IDLE') { chat('Already ' + S.state.toLowerCase() + '. Use !hs stop first.'); return; }
  const v = S.results[n - 1];
  if (!v) { chat('No result ' + n + '. Run !hs top or search first.'); return; }

  // Archive.org item — different path, no WebTorrent
  if (v._archive) { archivePick(v); return; }

  const host = v.account && v.account.host ? 'https://' + v.account.host : 'https://framatube.org';
  const uuid = v.uuid || v.id || v.shortUUID;
  if (!uuid) { chat('No video ID in result ' + n); return; }

  transition('FETCHING');
  setOverlay('Fetching video info…');

  fetch(host + '/api/v1/videos/' + uuid)
    .then(function (r) { if (!r.ok) throw new Error('API ' + r.status); return r.json(); })
    .then(function (data) {
      const files = (data.files || []).filter(function (f) {
        return (f.magnetUri || f.fileUrl) && !/-hls\./i.test(f.torrentUrl || '');
      });

      if (!files.length) {
        transition('IDLE');
        setOverlay('Nothing Playing');
        chat('\u26a0 "' + data.name + '" has no WebTorrent files (HLS-only instance). Try another.');
        return;
      }

      const sorted = files.slice().sort(function (a, b) {
        const ra = parseInt((a.resolution && (a.resolution.id || a.resolution.label)) || 0);
        const rb = parseInt((b.resolution && (b.resolution.id || b.resolution.label)) || 0);
        return rb - ra;
      });
      const target = sorted.find(function (f) {
        return parseInt((f.resolution && (f.resolution.id || f.resolution.label)) || 0) <= 720;
      }) || sorted[sorted.length - 1];

      const ws = target.fileUrl || null;
      const mag = target.magnetUri || null;

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

      // Transition to IDLE before starting swarm — startSwarmThenRelay requires IDLE state.
      // We were left in FETCHING from the fetch() above.
      // HEAD request removed: mode:'no-cors' always appears successful (opaque response),
      // so it was never a reliable reachability check. The httpFallback chain handles
      // unreachable URLs gracefully.
      transition('IDLE');
      startSwarmThenRelay(hash, ws || null, data.name);
    })
    .catch(function (e) {
      transition('IDLE');
      setOverlay('Nothing Playing');
      chat('Pick error: ' + e.message);
    });
}

// Play any magnet URI directly — !hs magnet <magnet-uri>
// Users can get magnets from: 1337x, archive.org, any torrent site
// fMP4 files under 200MB will use renderTo() for true P2P
// Larger files fall back to webseed HTTP if ws= param present in magnet
function cmdMagnet(magnet) {
  // Extract hash, display name, and webseed from magnet
  let hash = null, dn = null, ws = null;
  try {
    const url = new URL(magnet);
    url.searchParams.getAll('xt').forEach(function(v) {
      const m = v.match(/urn:btih:([0-9a-f]{40})/i);
      if (m) hash = m[1].toLowerCase();
    });
    dn = url.searchParams.get('dn') || null;
    ws = url.searchParams.get('ws') || null;
  } catch(e) {
    // fallback manual parse
    const hm = magnet.match(/urn:btih:([0-9a-f]{40})/i);
    if (hm) hash = hm[1].toLowerCase();
    const dm = magnet.match(/[?&]dn=([^&]+)/);
    if (dm) dn = decodeURIComponent(dm[1].replace(/\+/g,' '));
    const wm = magnet.match(/[?&]ws=([^&]+)/);
    if (wm) ws = decodeURIComponent(wm[1]);
  }
  if (!hash) { chat('Could not extract hash from magnet URI'); return; }
  const name = dn || hash.slice(0,8) + '…';
  chat('Loading: ' + name + ' [magnet]');
  startSwarmThenRelay(hash, ws, name);
}

// Play any PeerTube video URL directly — !hs pt https://instance.org/w/uuid
// These are fragmented MP4 files — renderTo() works = true P2P under 200MB
function cmdPt(url) {
  let origin, vid;
  try {
    const u = new URL(url);
    origin = u.origin;
    const m = u.pathname.match(/\/(?:videos\/watch|w)\/([^/?#]+)/);
    if (!m) throw new Error('Unrecognised PeerTube URL format');
    vid = m[1];
  } catch (e) { chat('PT URL error: ' + e.message); return; }

  transition('FETCHING');
  setOverlay('Fetching PeerTube info…');
  fetch(origin + '/api/v1/videos/' + vid)
    .then(function (r) { if (!r.ok) throw new Error('API ' + r.status); return r.json(); })
    .then(function (data) {
      const files = (data.files || []).filter(function (f) {
        return (f.magnetUri || f.fileUrl) && !/-hls\./i.test(f.torrentUrl || '');
      });
      if (!files.length) {
        transition('IDLE'); setOverlay('Nothing Playing');
        chat('⚠ "' + data.name + '" has no WebTorrent files (HLS-only). Try another.');
        return;
      }
      const sorted = files.slice().sort(function (a, b) {
        return parseInt((b.resolution && (b.resolution.id || b.resolution.label)) || 0) -
               parseInt((a.resolution && (a.resolution.id || a.resolution.label)) || 0);
      });
      const target = sorted.find(function (f) {
        return parseInt((f.resolution && (f.resolution.id || f.resolution.label)) || 0) <= 720;
      }) || sorted[sorted.length - 1];

      const ws = target.fileUrl || null;
      const mag = target.magnetUri || null;
      let hash = null;
      if (mag) { const m = mag.match(/urn:btih:([0-9a-f]{40})/i); if (m) hash = m[1].toLowerCase(); }
      if (!hash) { transition('IDLE'); setOverlay('Nothing Playing'); chat('No hash for: ' + data.name); return; }

      const res = String((target.resolution && (target.resolution.id || target.resolution.label)) || '?');
      chat('Playing: "' + data.name + '" [' + res + 'p]');
      setOverlay('Connecting…');
      transition('IDLE');
      startSwarmThenRelay(hash, ws, data.name);
    })
    .catch(function (e) { transition('IDLE'); setOverlay('Nothing Playing'); chat('PT error: ' + e.message); });
}

function cmdPickHash(hash) {
  if (!isCoordinator()) { chat('Only the room coordinator can start videos.'); return; }
  if (S.state !== 'IDLE') { chat('Stop current video first: !hs stop'); return; }
  const k = KNOWN[hash];
  const ws = k ? k.ws : null;
  const name = k ? k.name : hash.slice(0, 8) + '…';
  chat('Loading: ' + name);

  if (k && k.torrentUrl) {
    transition('METADATA');
    setOverlay('Loading…');
    if (!S.wt) S.wt = mkClient();

    const existing = S.wt.get(hash);
    if (existing) {
      log('reusing existing wt torrent:', hash);
      S.torrent = existing;
      S.activeWs = ws || null;
      if (ws) relay(encodeRelay(hash, ws));
      else relay('_i ' + hash + ' -');
      if (existing.files && existing.files.length) {
        transition('BUFFERING');
        S.activeWs = S.activeWs || null;
        attachVideo(existing, S.activeWs); startHUD(existing); startSyncTimer();
      } else {
        bindTorrent(existing);
      }
      return;
    }

    log('wt.add url:', k.torrentUrl);
    let t;
    try {
      t = S.wt.add(k.torrentUrl, { announce: CFG.trackers });
    } catch (e) {
      log('wt.add url failed:', e.message, '— trying magnet');
      try {
        t = S.wt.add(buildMagnet(hash, ws, name));
      } catch (e2) {
        t = S.wt.get(hash);
        if (!t) { errlog('all add methods failed'); transition('IDLE'); return; }
      }
    }
    S.torrent = t;
    S.activeWs = ws || null;  // MUST be set before bindTorrent→attachVideo

    const relayOnce = function () {
      log('infoHash confirmed — relaying to peers now');
      if (ws) relay(encodeRelay(hash, ws));
      else relay('_i ' + hash + ' -');
    };

    if (t.infoHash) {
      log('infoHash already present:', t.infoHash);
      relayOnce();
    } else {
      t.once('infoHash', function () { relayOnce(); });
    }
    bindTorrent(t);
  } else {
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
  #hs-root{width:100%;background:#080808;border:1px solid #1a1a1a;font-family:'Courier New',Courier,monospace;box-sizing:border-box;margin-bottom:8px;}
  #hs-toolbar{display:flex;align-items:center;gap:6px;padding:5px 8px;background:#0d0d0d;border-bottom:1px solid #1a1a1a;flex-wrap:wrap;}
  #hs-toolbar input{flex:1;min-width:140px;padding:4px 8px;background:#000;color:#39ff14;border:1px solid #1c1c1c;outline:none;font:12px 'Courier New',monospace;}
  #hs-toolbar input::placeholder{color:#2a2a2a;}
  #hs-toolbar input:focus{border-color:#39ff14;}
  .hs-btn{padding:4px 10px;background:#000;color:#39ff14;border:1px solid #1c1c1c;cursor:pointer;font:11px 'Courier New',monospace;white-space:nowrap;transition:all .15s;}
  .hs-btn:hover{background:#39ff14;color:#000;}
  .hs-btn.danger{color:#ff3939;border-color:#1c1c1c;}
  .hs-btn.danger:hover{background:#ff3939;color:#000;}
  #hs-state{font:10px 'Courier New',monospace;padding:2px 8px;border:1px solid #1c1c1c;color:#555;margin-left:auto;white-space:nowrap;}
  .hs-state-playing{color:#39ff14!important;border-color:#39ff14!important;}
  .hs-state-seeding{color:#39f!important;border-color:#39f!important;}
  .hs-state-buffering,.hs-state-metadata{color:#ff9939!important;border-color:#ff9939!important;}
  .hs-state-fetching{color:#999!important;}
  #hs-grid{display:flex;overflow-x:auto;gap:4px;padding:6px;background:#050505;scrollbar-width:thin;scrollbar-color:#1a1a1a #000;}
  #hs-grid:empty{display:none;}
  #hs-grid::-webkit-scrollbar{height:4px;}
  #hs-grid::-webkit-scrollbar-thumb{background:#1a1a1a;}
  .hs-thumb{cursor:pointer;flex-shrink:0;width:120px;border:1px solid #111;transition:border-color .15s;background:#0a0a0a;}
  .hs-thumb:hover{border-color:#39ff14;}
  .hs-thumb img{width:120px;height:67px;object-fit:cover;display:block;background:#111;}
  .hs-tlabel{color:#888;font:9px 'Courier New',monospace;padding:2px 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .hs-tlabel:hover{color:#39ff14;}
  .hs-tdur{color:#333;font:9px 'Courier New',monospace;padding:0 4px 3px;}
  #hs-vwrap{position:relative;background:#000;min-height:280px;}
  #hs-video{width:100%;display:block;min-height:280px;background:#000;}
  #hs-hud{position:absolute;top:6px;left:6px;background:rgba(0,0,0,.8);color:#39ff14;font:9px 'Courier New',monospace;padding:2px 6px;pointer-events:none;border:1px solid #1a1a1a;}
  #hs-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#222;font:13px 'Courier New',monospace;pointer-events:none;}
  #hs-debug{position:fixed;bottom:0;left:0;right:0;z-index:99999;background:rgba(0,0,0,.96);border-top:1px solid #1a1a1a;display:none;flex-direction:column;}
  #hs-dbtop{display:flex;align-items:center;gap:6px;padding:3px 8px;background:#050505;border-bottom:1px solid #111;}
  #hs-dbtop span{color:#333;font:10px 'Courier New',monospace;flex:1;}
  #hs-dbtop .hs-btn{font-size:9px;padding:2px 6px;}
  #hs-dblog{color:#39ff14;font:9px 'Courier New',monospace;padding:6px 8px;height:150px;overflow-y:auto;white-space:pre-wrap;word-break:break-all;scrollbar-width:thin;scrollbar-color:#1a1a1a #000;}
  #hs-dbtoggle{position:fixed;bottom:4px;right:4px;z-index:100000;background:#000;border:1px solid #1a1a1a;color:#333;font:9px 'Courier New',monospace;padding:3px 8px;cursor:pointer;}
  #hs-dbtoggle:hover{border-color:#39ff14;color:#39ff14;}

  /* ── Persistent custom controls ── */
  #hs-video{pointer-events:none;}  /* clicks go to our bar, not native controls */
  #hs-controls{
    display:flex;align-items:center;gap:8px;
    padding:6px 8px;background:#0d0d0d;border-top:1px solid #1a1a1a;
    flex-shrink:0;
  }
  #hs-controls button{
    background:none;border:none;color:#39ff14;cursor:pointer;
    font-size:16px;padding:2px 6px;line-height:1;flex-shrink:0;
  }
  #hs-controls button:hover{color:#fff;}
  #hs-seek{
    flex:1;height:3px;accent-color:#39ff14;cursor:pointer;
    background:#222;border-radius:2px;
  }
  #hs-time{
    color:#555;font:10px 'Courier New',monospace;white-space:nowrap;flex-shrink:0;
  }
  `;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'hs-root';

  const tb = document.createElement('div');
  tb.id = 'hs-toolbar';
  tb.innerHTML =
    '<input id="hs-sinput" placeholder="search peertube…">' +
    '<button class="hs-btn" id="hs-sbtn">search</button>' +
    '<button class="hs-btn" id="hs-topbtn">top 10</button>' +
    '<button class="hs-btn danger" id="hs-stopbtn">stop</button>' +
    '<span id="hs-state" class="hs-state">○ idle</span>';
  root.appendChild(tb);

  const grid = document.createElement('div');
  grid.id = 'hs-grid';
  root.appendChild(grid);

  const vwrap = document.createElement('div');
  vwrap.id = 'hs-vwrap';

  const vid = document.createElement('video');
  vid.id = 'hs-video'; vid.controls = false; vid.autoplay = true; vid.playsInline = true;
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

  // ── Persistent control bar ──
  const ctrlBar = document.createElement('div');
  ctrlBar.id = 'hs-controls';
  ctrlBar.innerHTML =
    '<button id="hs-playbtn" title="Play/Pause">▶</button>' +
    '<input id="hs-seek" type="range" min="0" max="1000" value="0" step="1">' +
    '<span id="hs-time">0:00 / 0:00</span>' +
    '<button id="hs-syncbtn" title="Sync room to my position" style="font-size:11px">sync</button>' +
    '<button id="hs-mutebtn" title="Mute/Unmute">🔊</button>' +
    '<button id="hs-fullbtn" title="Fullscreen">⛶</button>';
  root.appendChild(ctrlBar);

  const main = document.getElementById('main');
  if (main) main.parentNode.insertBefore(root, main);
  else document.body.prepend(root);

  document.getElementById('hs-sbtn').onclick = function () {
    const v = document.getElementById('hs-sinput').value.trim();
    if (v) cmdSearch(v);
  };
  document.getElementById('hs-sinput').onkeydown = function (e) {
    if (e.key === 'Enter') { const v = e.target.value.trim(); if (v) cmdSearch(v); }
  };
  document.getElementById('hs-topbtn').onclick = cmdTop;
  document.getElementById('hs-stopbtn').onclick = function () { stopAll(true); };

  // Play/pause button
  document.getElementById('hs-playbtn').onclick = function () {
    if (!S.video) return;
    if (S.video.paused) {
      S.video.play().catch(function(){});
    } else {
      S.video.pause();
    }
  };

  // Seek bar — update while dragging
  document.getElementById('hs-seek').oninput = function () {
    if (!S.video || !S.video.duration) return;
    S.video.currentTime = (this.value / 1000) * S.video.duration;
  };

  // Mute/unmute
  document.getElementById('hs-mutebtn').onclick = function () {
    if (!S.video) return;
    S.video.muted = !S.video.muted;
    this.textContent = S.video.muted ? '🔇' : '🔊';
  };

  // Sync — broadcast coordinator's current position to room
  document.getElementById('hs-syncbtn').onclick = function () {
    if (!S.video || !S.video.duration) { chat('Nothing playing to sync.'); return; }
    const t = S.video.currentTime.toFixed(2);
    relay('_s ' + t);
    chat('Synced room to ' + fmtDur(S.video.currentTime));
    const btn = document.getElementById('hs-syncbtn');
    if (btn) { btn.textContent = '✓ synced'; setTimeout(function () { btn.textContent = 'sync'; }, 2000); }
  };

  // Fullscreen
  document.getElementById('hs-fullbtn').onclick = function () {
    const vw = document.getElementById('hs-vwrap');
    if (!vw) return;
    if (document.fullscreenElement) {
      document.exitFullscreen && document.exitFullscreen();
    } else {
      (vw.requestFullscreen || vw.webkitRequestFullscreen || function(){}).call(vw);
    }
  };

  // Tick — update seek bar and time display every 500ms
  setInterval(function () {
    const v = S.video;
    if (!v || !v.duration) return;
    const seek = document.getElementById('hs-seek');
    const time = document.getElementById('hs-time');
    const play = document.getElementById('hs-playbtn');
    const mute = document.getElementById('hs-mutebtn');
    if (seek && !seek.matches(':active')) seek.value = Math.round((v.currentTime / v.duration) * 1000);
    if (time) time.textContent = fmtDur(v.currentTime) + ' / ' + fmtDur(v.duration);
    if (play) play.textContent = v.paused ? '▶' : '⏸';
    if (mute) mute.textContent = v.muted ? '🔇' : '🔊';
  }, 500);

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
    const hostFull = r.account && r.account.host ? 'https://' + r.account.host : '';
    const host = r.account && r.account.host ? r.account.host : '';
    img.src = r.thumbnailUrl || (r.thumbnailPath ? hostFull + r.thumbnailPath : '');
    img.onerror = function () { this.style.display = 'none'; };
    const label = document.createElement('div');
    label.className = 'hs-tlabel';
    label.title = r.name || '';
    label.textContent = (i + 1) + '. ' + (r.name || 'video');
    const dur = document.createElement('div');
    dur.className = 'hs-tdur';
    // Show ⚠ on thumbnails from instances not confirmed WebTorrent-compatible
    const hlsWarn = host && !r._archive && !WEBTORRENT_INSTANCES.includes(host) ? ' ⚠' : '';
    dur.textContent = fmtDur(r.duration) + (host ? ' · ' + host : '') + hlsWarn;
    if (hlsWarn) dur.title = 'Instance not confirmed WebTorrent-compatible — may show HLS error';
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
    const oldV = e.oldVersion;
    log('IDB upgrade from v' + oldV + ' to v' + CFG.idbVersion);
    // Delete and recreate stores on any version change — clears stale/corrupt data.
    // Users re-download once then cache cleanly with the fixed storage code.
    if (db.objectStoreNames.contains('torrents')) db.deleteObjectStore('torrents');
    if (db.objectStoreNames.contains('meta')) db.deleteObjectStore('meta');
    db.createObjectStore('torrents');
    db.createObjectStore('meta');
    log('IDB stores recreated — stale data cleared');
  };
  r.onsuccess = function (e) {
    S.idb = e.target.result;
    log('IDB open: v' + CFG.idbVersion);
    autoSeedFromIDB();
  };
  r.onerror = function (e) { warn('IDB open error:', e.target.error); };
}

function idbStoreTorrent(t) {
  if (!S.idb) return;
  // Retry up to 6 times — torrentFile may not be set immediately after 'done'
  function tryStore(attempts) {
    if (!t.torrentFile) {
      if (attempts > 0) { setTimeout(function () { tryStore(attempts - 1); }, 500); return; }
      warn('IDB: torrentFile never available for', t.infoHash);
      return;
    }
    try {
      // t.torrentFile is a Node-style Buffer. Its .buffer property is a SHARED
      // ArrayBuffer that may be larger than the actual data (byteOffset/byteLength
      // mark the slice we own). We must copy just our slice into a fresh ArrayBuffer,
      // otherwise wt.add() reads garbage bytes and throws "Invalid torrent identifier".
      const b = t.torrentFile;
      let clean;
      if (b.byteOffset !== undefined && b.byteLength !== undefined) {
        // Buffer/Uint8Array: copy our slice only
        clean = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      } else {
        clean = b.buffer || b; // already an ArrayBuffer
      }
      if (!clean || clean.byteLength < 20) { warn('IDB: torrent data too small, skipping'); return; }
      const tx = S.idb.transaction('torrents', 'readwrite');
      tx.objectStore('torrents').put(clean, t.infoHash);
      log('IDB stored:', t.infoHash, '(' + clean.byteLength + 'B)');
    } catch (e) { warn('IDB store error:', e.message || e); }
  }
  tryStore(6);
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

function autoSeedFromIDB() {
  if (!S.idb) return;
  try {
    const tx = S.idb.transaction('torrents', 'readonly');
    const req = tx.objectStore('torrents').getAllKeys();
    req.onsuccess = function () {
      const hashes = req.result || [];
      log('IDB cache:', hashes.length, 'torrent(s)');
      if (!hashes.length) return;
      hashes.forEach(function (hash, idx) {
        idbGetTorrent(hash, function (buf) {
          if (!buf || !S.wt) return;
          if (S.wt.get(hash)) { log('IDB: already in wt client:', hash); return; }
          try {
            const t = S.wt.add(new Uint8Array(buf), { announce: CFG.trackers });
            log('IDB: loaded', hash, '— seeding');
            t.on('error', function (e) {
              if ((e.message || '').indexOf('duplicate') >= 0) return;
              warn('IDB torrent error:', e.message);
            });
            t.on('metadata', function () {
              log('IDB seed ready:', t.name, t.infoHash);
              if (isCoordinator() && idx === hashes.length - 1 && S.state === 'IDLE') {
                S.torrent = t;
                transition('SEEDING');
                attachVideo(t, S.activeWs);
                startHUD(t);
                startSyncTimer();
                chat('"' + t.name + '" restored from cache — seeding to room');
                const k = KNOWN[t.infoHash];
                const ws = k ? k.ws : null;
                if (ws) relay(encodeRelay(t.infoHash, ws));
                else relay('_i ' + t.infoHash + ' -');
              }
            });
          } catch (e) {
            if ((e.message || '').indexOf('duplicate') >= 0) return;
            warn('IDB add error:', hash, e.message);
          }
        });
      });
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
  socket.on('rank', function (r) { S.myRank = r; log('rank:', r); });
  socket.on('login', function (d) {
    if (d && d.name) { S.myName = d.name; if (d.rank !== undefined) S.myRank = d.rank; }
  });

  // Hook CyTube's leader system — if we're made leader, take coordinator role.
  // CLIENT.leader is set by CyTube's setLeader callback.
  socket.on('setLeader', function (name) {
    if (name === S.myName) {
      log('CyTube setLeader: we are now leader — coordinator active');
      // CyTube leader = HiveStream coordinator: start sync timer
      if (S.video && S.torrent) startSyncTimer();
    }
  });

  // Hook changeMedia — if CyTube playlist advances to a non-HiveStream item,
  // stop HiveStream so the native CyTube player can take over.
  socket.on('changeMedia', function (data) {
    log('changeMedia:', data && data.title);
    // If HiveStream is active and CyTube just switched media, stop HS
    // unless the new item is a custom embed (type 'cu') — those are ours.
    if (S.state !== 'IDLE' && data && data.type && data.type !== 'cu') {
      log('changeMedia: non-HS media detected, stopping HiveStream');
      stopAll(false);
    }
  });

  log('chat hooked');
}

function onCmd(sender, cmd, args) {
  if (cmd === '_m' || cmd === '_t') { log('ignoring legacy relay:', cmd); return; }
  if (cmd === '_i') {
    const { hash, ws } = decodeRelay(args[0] || '', args[1] || '-');
    log('relay _i hash=' + hash + ' ws=' + ws.slice(0, 60));

    // If already active (BUFFERING/PLAYING/SEEDING), ignore even if we have the torrent.
    // This prevents the coordinator from double-attaching when they receive their own relay.
    if (S.state !== 'IDLE') { log('_i: state=' + S.state + ', ignoring relay'); return; }

    // IDB fast-path: if we already downloaded this torrent in a prior session, attach immediately
    const cached = S.wt ? S.wt.get(hash) : null;
    if (cached && cached.files && cached.files.length) {
      log('_i: IDB cache hit — attaching directly');
      S.torrent = cached;
      S.activeWs = ws || null;
      transition('BUFFERING');
      attachVideo(cached, ws || null);
      startHUD(cached);
      startSyncTimer();
      return;
    }
    startSwarm(hash, ws || null, null);
    return;
  }
  if (cmd === '_s') { applySync(parseFloat(args[0])); return; }

  if (cmd === 'help') { cmdHelp(); return; }
  if (cmd === 'status') { dumpStatus(); cmdStatus(); return; }
  if (cmd === 'info') { cmdInfo(parseInt(args[0])); return; }
  if (cmd === 'stop') { stopAll(false); return; }

  if (cmd === 'search') { if (sender === S.myName) cmdSearch(args.join(' ')); return; }
  if (cmd === 'archive') { if (sender === S.myName) cmdArchive(args.join(' ')); return; }
  if (cmd === 'top') { if (sender === S.myName) cmdTop(); return; }
  if (cmd === 'pick') {
    if (sender === S.myName) { const n = parseInt(args[0]); if (!isNaN(n)) cmdPick(n); }
    return;
  }
  if (/^[0-9a-f]{40}$/i.test(cmd)) {
    if (sender === S.myName) cmdPickHash(cmd.toLowerCase());
    return;
  }
  if (cmd === 'pt') {
    if (sender === S.myName) {
      const ptUrl = args[0];
      if (!ptUrl) { chat('Usage: !hs pt <peertube-video-url>'); return; }
      if (S.state !== 'IDLE') { chat('Already ' + S.state.toLowerCase() + '. Use !hs stop first.'); return; }
      if (!isCoordinator()) { chat('Only the coordinator can start videos.'); return; }
      cmdPt(ptUrl);
    }
    return;
  }
  if (cmd === 'magnet') {
    if (sender === S.myName) {
      // Reconstruct full magnet URI — CyTube may have split it across args
      const raw = args.join(' ');
      // Find magnet: URI in the full body — handles CyTube HTML-encoding
      const mag = raw.indexOf('magnet:') >= 0 ? raw.slice(raw.indexOf('magnet:')) : raw;
      if (!mag.startsWith('magnet:')) { chat('Usage: !hs magnet <magnet-uri>'); return; }
      if (S.state !== 'IDLE') { chat('Already ' + S.state.toLowerCase() + '. Use !hs stop first.'); return; }
      if (!isCoordinator()) { chat('Only the coordinator can start videos.'); return; }
      cmdMagnet(mag);
    }
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
  chat('HiveStream v' + V + ': top | search <q> | search archive:<q> | pick <n> | <hash> | magnet <uri> | pt <url> | sync | seek <s> | stop | status');
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
      // CLIENT.leader is set by CyTube when this user is designated sync leader
      log('CLIENT.leader:', CLIENT.leader);
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

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

})();
