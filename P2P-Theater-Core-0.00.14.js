// ============================================================
// P2P-Theater-Core / HiveStream  v0.00.14
// Modern CyTube P2P media layer
// Uses p2p-media-loader + hls.js (PeerTube-style)
// ============================================================
//
// CHANGELOG v0.00.14
// ─────────────────────────────────────────────────────────────
// • Complete rewrite around p2p-media-loader + hls.js
// • Chat-based signaling: !hs swarm=<id> [url=<m3u8>]
// • Automatic deterministic swarmId from media URL + room
// • Live stats HUD (peers, HTTP bytes, P2P down/up)
// • Much cleaner state machine and less tracker spam
// • Keeps !hs command compatibility idea from 0.00.13
// ============================================================

(function () {
  'use strict';

  const VERSION = '0.00.14';
  if (window.__HS_VERSION === VERSION) return;
  window.__HS_VERSION = VERSION;

  // ── Config ────────────────────────────────────────────────
  const CFG = {
    cmd: '!hs',
    trackers: [
      'wss://tracker.openwebtorrent.com',
      'wss://tracker.novage.com.ua',
      'wss://tracker.files.fm:7073/announce'
    ]
  };

  // ── State ─────────────────────────────────────────────────
  const S = {
    hls: null,
    p2pEngine: null,
    currentSwarmId: null,
    currentUrl: null,
    peers: 0,
    httpBytes: 0,
    p2pDown: 0,
    p2pUp: 0,
    myName: '',
    myRank: -1
  };

  // ── Helpers ───────────────────────────────────────────────
  function log(...args) {
    console.log('[HS 0.00.14]', ...args);
  }

  function chat(msg) {
    if (!window.socket) return;
    socket.emit('chatMsg', { msg: msg });
  }

  function isLeader() {
    // Simple heuristic – improve later with real rank checks
    return S.myRank >= 2 || document.querySelector('.userlist_item.rank2, .userlist_item.rank3, .userlist_item.rank4, .userlist_item.rank5');
  }

  function makeSwarmId(url) {
    // Deterministic swarm ID so everyone in the room joins the same swarm
    const room = (window.CHANNEL && window.CHANNEL.name) || location.pathname.split('/').pop() || 'room';
    const clean = (url || '').split('?')[0];
    return `hs-${room}-${btoa(clean).replace(/=+$/, '').slice(0, 24)}`;
  }

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  // ── UI / HUD ──────────────────────────────────────────────
  function ensureHUD() {
    if (document.getElementById('hs-hud')) return;

    const hud = document.createElement('div');
    hud.id = 'hs-hud';
    hud.style.cssText = `
      position: fixed; bottom: 12px; right: 12px; z-index: 99999;
      background: rgba(0,0,0,0.82); color: #eee; padding: 10px 14px;
      border-radius: 8px; font: 13px/1.4 monospace; min-width: 200px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    `;
    hud.innerHTML = `
      <div style="font-weight:bold;margin-bottom:4px">HiveStream ${VERSION}</div>
      <div>Swarm: <span id="hs-swarm">—</span></div>
      <div>Peers: <span id="hs-peers">0</span></div>
      <div>HTTP: <span id="hs-http">0 B</span></div>
      <div>P2P ↓: <span id="hs-p2p-down">0 B</span></div>
      <div>P2P ↑: <span id="hs-p2p-up">0 B</span></div>
      <div style="margin-top:6px;font-size:11px;opacity:0.7">!hs help</div>
    `;
    document.body.appendChild(hud);
  }

  function updateHUD() {
    const el = (id) => document.getElementById(id);
    if (!el('hs-peers')) return;
    el('hs-swarm').textContent = S.currentSwarmId ? S.currentSwarmId.slice(0, 18) + '…' : '—';
    el('hs-peers').textContent = S.peers;
    el('hs-http').textContent = formatBytes(S.httpBytes);
    el('hs-p2p-down').textContent = formatBytes(S.p2pDown);
    el('hs-p2p-up').textContent = formatBytes(S.p2pUp);
  }

  // ── Core Player ───────────────────────────────────────────
  async function startP2P(url, swarmId) {
    ensureHUD();

    // Clean previous
    if (S.hls) {
      try { S.hls.destroy(); } catch (e) {}
      S.hls = null;
    }

    S.currentUrl = url;
    S.currentSwarmId = swarmId || makeSwarmId(url);
    S.peers = 0;
    S.httpBytes = 0;
    S.p2pDown = 0;
    S.p2pUp = 0;
    updateHUD();

    log('Starting', url, 'swarm=', S.currentSwarmId);

    // Dynamic import of p2p-media-loader (modern way)
    try {
      const { HlsJsP2PEngine } = await import('https://cdn.jsdelivr.net/npm/p2p-media-loader-hlsjs@4/dist/p2p-media-loader-hlsjs.es.min.js');

      // Make sure hls.js is present
      if (typeof Hls === 'undefined') {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js';
          s.onload = resolve;
          s.onerror = reject;
          document.head.appendChild(s);
        });
      }

      const HlsWithP2P = HlsJsP2PEngine.injectMixin(Hls);

      const video = document.querySelector('video') || document.getElementById('ytapiplayer') || document.querySelector('#videowrap video');
      if (!video) {
        log('No video element found');
        return;
      }

      S.hls = new HlsWithP2P({
        enableWorker: true,
        p2p: {
          core: {
            swarmId: S.currentSwarmId,
            announceTrackers: CFG.trackers
          },
          onHlsJsCreated(hls) {
            const engine = hls.p2pEngine;
            if (!engine) return;

            engine.addEventListener('onPeerConnect', () => {
              S.peers++;
              updateHUD();
              log('Peer connected – total', S.peers);
            });
            engine.addEventListener('onPeerClose', () => {
              S.peers = Math.max(0, S.peers - 1);
              updateHUD();
            });

            // Basic byte tracking (event shape can vary by version)
            engine.addEventListener('onSegmentLoaded', (e) => {
              const size = e.bytesLength || e.size || 0;
              if (e.downloadSource === 'p2p' || e.source === 'p2p') {
                S.p2pDown += size;
              } else {
                S.httpBytes += size;
              }
              updateHUD();
            });
          }
        }
      });

      S.hls.loadSource(url);
      S.hls.attachMedia(video);

      S.hls.on(Hls.Events.MANIFEST_PARSED, () => {
        log('Manifest parsed – playing');
        video.play().catch(() => {});
      });

    } catch (err) {
      console.error('[HS] Failed to start P2P engine', err);
      // Fallback to plain hls.js if needed
    }
  }

  // ── Chat Command Parser ───────────────────────────────────
  function handleChat(data) {
    if (!data || !data.msg) return;
    const msg = data.msg.trim();

    if (!msg.startsWith(CFG.cmd)) return;

    const parts = msg.slice(CFG.cmd.length).trim().split(/\s+/);
    const cmd = (parts[0] || '').toLowerCase();

    if (cmd === 'help') {
      chat(`${CFG.cmd} swarm=<id>          – join/create swarm`);
      chat(`${CFG.cmd} play <m3u8-url>     – play with auto swarm`);
      chat(`${CFG.cmd} status              – show current swarm`);
      return;
    }

    if (cmd === 'status') {
      chat(`HS swarm=${S.currentSwarmId || 'none'} peers=${S.peers}`);
      return;
    }

    if (cmd === 'play' && parts[1]) {
      const url = parts[1];
      const sid = makeSwarmId(url);
      chat(`${CFG.cmd} swarm=${sid} url=${url}`);
      startP2P(url, sid);
      return;
    }

    // !hs swarm=xxxx  or  !hs swarm=xxxx url=...
    let swarmId = null;
    let url = null;
    parts.forEach(p => {
      if (p.startsWith('swarm=')) swarmId = p.slice(6);
      if (p.startsWith('url=')) url = p.slice(4);
    });

    if (swarmId) {
      if (url) {
        startP2P(url, swarmId);
      } else if (S.currentUrl) {
        startP2P(S.currentUrl, swarmId);
      } else {
        S.currentSwarmId = swarmId;
        updateHUD();
        log('Joined swarm', swarmId, '(waiting for media)');
      }
    }
  }

  // ── Initialization ────────────────────────────────────────
  function init() {
    ensureHUD();
    log('HiveStream', VERSION, 'loaded');

    // Listen to CyTube chat
    if (window.socket) {
      socket.on('chatMsg', handleChat);
    } else {
      // Retry a few times – CyTube socket may not be ready yet
      let tries = 0;
      const t = setInterval(() => {
        if (window.socket) {
          clearInterval(t);
          socket.on('chatMsg', handleChat);
          log('Socket attached');
        } else if (++tries > 20) {
          clearInterval(t);
        }
      }, 500);
    }

    // Optional: react to media changes
    if (window.socket) {
      socket.on('changeMedia', (data) => {
        // You can auto-announce here later
      });
    }
  }

  // Start
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
