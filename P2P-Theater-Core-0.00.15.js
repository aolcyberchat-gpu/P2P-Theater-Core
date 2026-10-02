// ============================================================
// P2P-Theater-Core / HiveStream  v0.00.15
// Fixed version – more reliable loading + better CyTube video handling
// ============================================================

(function () {
  'use strict';

  const VERSION = '0.00.15';
  if (window.__HS_VERSION === VERSION) return;
  window.__HS_VERSION = VERSION;

  const CFG = {
    cmd: '!hs',
    trackers: [
      'wss://tracker.openwebtorrent.com',
      'wss://tracker.novage.com.ua',
      'wss://tracker.files.fm:7073/announce'
    ]
  };

  const S = {
    hls: null,
    currentSwarmId: null,
    currentUrl: null,
    peers: 0,
    httpBytes: 0,
    p2pDown: 0,
    p2pUp: 0,
    status: 'idle'
  };

  function log(...args) {
    console.log('[HS ' + VERSION + ']', ...args);
  }

  function chat(msg) {
    if (window.socket) socket.emit('chatMsg', { msg });
  }

  function makeSwarmId(url) {
    const room = (window.CHANNEL && window.CHANNEL.name) || location.pathname.split('/').pop() || 'room';
    const clean = (url || '').split('?')[0];
    return `hs-${room}-${btoa(unescape(encodeURIComponent(clean))).replace(/=+$/, '').slice(0, 20)}`;
  }

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  // ── HUD ───────────────────────────────────────────────────
  function ensureHUD() {
    if (document.getElementById('hs-hud')) return;

    const hud = document.createElement('div');
    hud.id = 'hs-hud';
    hud.style.cssText = `
      position: fixed; bottom: 12px; right: 12px; z-index: 99999;
      background: rgba(0,0,0,0.85); color: #eee; padding: 10px 14px;
      border-radius: 8px; font: 13px/1.45 monospace; min-width: 220px;
      box-shadow: 0 4px 14px rgba(0,0,0,0.5);
    `;
    hud.innerHTML = `
      <div style="font-weight:bold;margin-bottom:4px">HiveStream ${VERSION}</div>
      <div>Status: <span id="hs-status">idle</span></div>
      <div>Swarm: <span id="hs-swarm">—</span></div>
      <div>Peers: <span id="hs-peers">0</span></div>
      <div>HTTP: <span id="hs-http">0 B</span></div>
      <div>P2P ↓: <span id="hs-p2p-down">0 B</span></div>
      <div>P2P ↑: <span id="hs-p2p-up">0 B</span></div>
      <div style="margin-top:6px;font-size:11px;opacity:0.7">!hs help</div>
    `;
    document.body.appendChild(hud);
  }

  function setStatus(text) {
    S.status = text;
    const el = document.getElementById('hs-status');
    if (el) el.textContent = text;
  }

  function updateHUD() {
    const el = id => document.getElementById(id);
    if (!el('hs-peers')) return;
    el('hs-swarm').textContent = S.currentSwarmId ? S.currentSwarmId.slice(0, 18) + '…' : '—';
    el('hs-peers').textContent = S.peers;
    el('hs-http').textContent = formatBytes(S.httpBytes);
    el('hs-p2p-down').textContent = formatBytes(S.p2pDown);
    el('hs-p2p-up').textContent = formatBytes(S.p2pUp);
  }

  // ── Find or create video element ──────────────────────────
  function getVideoElement() {
    // Common CyTube locations
    let video = document.querySelector('#ytapiplayer video') ||
                document.querySelector('#videowrap video') ||
                document.querySelector('video');

    if (video) return video;

    // Create our own player area if nothing exists
    const wrap = document.getElementById('videowrap') || document.getElementById('ytapiplayer') || document.body;
    video = document.createElement('video');
    video.controls = true;
    video.style.width = '100%';
    video.style.maxHeight = '70vh';
    video.id = 'hs-video';
    wrap.appendChild(video);
    log('Created fallback <video> element');
    return video;
  }

  // ── Load libraries (IIFE style – more reliable) ───────────
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) return resolve();
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Failed to load ' + src));
      document.head.appendChild(s);
    });
  }

  async function ensureLibraries() {
    setStatus('loading libs…');
    await loadScript('https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js');
    await loadScript('https://cdn.jsdelivr.net/npm/p2p-media-loader-hlsjs@4.0.0/dist/p2p-media-loader-hlsjs.iife.min.js');
    setStatus('libs ready');
  }

  // ── Main player ───────────────────────────────────────────
  async function startP2P(url, swarmId) {
    ensureHUD();
    setStatus('starting…');

    try {
      await ensureLibraries();
    } catch (e) {
      setStatus('lib load failed');
      console.error(e);
      return;
    }

    if (S.hls) {
      try { S.hls.destroy(); } catch (_) {}
      S.hls = null;
    }

    S.currentUrl = url;
    S.currentSwarmId = swarmId || makeSwarmId(url);
    S.peers = 0;
    S.httpBytes = 0;
    S.p2pDown = 0;
    S.p2pUp = 0;
    updateHUD();

    const video = getVideoElement();
    log('Using video element', video);

    // Use the global from the IIFE build
    const HlsJsP2PEngine = window.p2pml && window.p2pml.hlsjs && window.p2pml.hlsjs.HlsJsP2PEngine
      ? window.p2pml.hlsjs.HlsJsP2PEngine
      : (window.HlsJsP2PEngine || null);

    if (!HlsJsP2PEngine) {
      setStatus('P2P engine missing');
      log('p2pml not found on window – falling back to plain hls.js');
      // Fallback
      if (window.Hls) {
        S.hls = new Hls();
        S.hls.loadSource(url);
        S.hls.attachMedia(video);
        S.hls.on(Hls.Events.MANIFEST_PARSED, () => {
          setStatus('playing (no p2p)');
          video.play().catch(() => {});
        });
      }
      return;
    }

    const HlsWithP2P = HlsJsP2PEngine.injectMixin(Hls);

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
          });
          engine.addEventListener('onPeerClose', () => {
            S.peers = Math.max(0, S.peers - 1);
            updateHUD();
          });
        }
      }
    });

    S.hls.loadSource(url);
    S.hls.attachMedia(video);

    S.hls.on(Hls.Events.MANIFEST_PARSED, () => {
      setStatus('playing');
      log('Manifest parsed – should be playing');
      video.play().catch(e => log('play() blocked', e));
    });

    S.hls.on(Hls.Events.ERROR, (event, data) => {
      if (data.fatal) {
        setStatus('error: ' + (data.details || data.type));
        console.error('HLS fatal error', data);
      }
    });
  }

  // ── Chat handler ──────────────────────────────────────────
  function handleChat(data) {
    if (!data || !data.msg) return;
    const msg = data.msg.trim();
    if (!msg.startsWith(CFG.cmd)) return;

    const rest = msg.slice(CFG.cmd.length).trim();
    const parts = rest.split(/\s+/);
    const cmd = (parts[0] || '').toLowerCase();

    if (cmd === 'help') {
      chat(`${CFG.cmd} play <m3u8>`);
      chat(`${CFG.cmd} swarm=<id> url=<m3u8>`);
      chat(`${CFG.cmd} status`);
      return;
    }

    if (cmd === 'status') {
      chat(`HS ${S.status} swarm=${S.currentSwarmId || 'none'} peers=${S.peers}`);
      return;
    }

    if (cmd === 'play' && parts[1]) {
      const url = parts[1];
      startP2P(url);
      return;
    }

    // Parse key=value
    let swarmId = null, url = null;
    parts.forEach(p => {
      if (p.startsWith('swarm=')) swarmId = p.slice(6);
      if (p.startsWith('url=')) url = p.slice(4);
    });

    if (swarmId && url) {
      startP2P(url, swarmId);
    } else if (url) {
      startP2P(url);
    } else if (swarmId) {
      S.currentSwarmId = swarmId;
      updateHUD();
      setStatus('swarm set');
    }
  }

  // ── Init ──────────────────────────────────────────────────
  function init() {
    ensureHUD();
    setStatus('ready');
    log('HiveStream', VERSION, 'ready');

    if (window.socket) {
      socket.on('chatMsg', handleChat);
    } else {
      let tries = 0;
      const t = setInterval(() => {
        if (window.socket) {
          clearInterval(t);
          socket.on('chatMsg', handleChat);
          log('Socket attached');
        } else if (++tries > 30) clearInterval(t);
      }, 400);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
