// ============================================================
// P2P-Theater-Core / HiveStream  v0.00.16
// Mobile-friendly + correct CyTube #ytapiplayer takeover
// ============================================================

(function () {
  'use strict';

  const VERSION = '0.00.16';
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
    video: null,
    currentSwarmId: null,
    currentUrl: null,
    peers: 0,
    httpBytes: 0,
    p2pDown: 0,
    p2pUp: 0,
    status: 'idle',
    lastError: '',
    log: []
  };

  function log(...args) {
    const line = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    S.log.push('[' + new Date().toLocaleTimeString() + '] ' + line);
    if (S.log.length > 40) S.log.shift();
    console.log('[HS ' + VERSION + ']', ...args);
  }

  function chat(msg) {
    if (window.socket) {
      socket.emit('chatMsg', { msg: msg });
    }
  }

  function makeSwarmId(url) {
    const room = (window.CHANNEL && window.CHANNEL.name) ||
                 (location.pathname.split('/').pop()) || 'room';
    const clean = (url || '').split('?')[0];
    let hash = 0;
    for (let i = 0; i < clean.length; i++) {
      hash = ((hash << 5) - hash) + clean.charCodeAt(i);
      hash |= 0;
    }
    return 'hs-' + room + '-' + Math.abs(hash).toString(36);
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
      position: fixed; bottom: 8px; right: 8px; z-index: 99999;
      background: rgba(0,0,0,0.88); color: #eee; padding: 10px 12px;
      border-radius: 8px; font: 12px/1.4 monospace; max-width: 260px;
      box-shadow: 0 4px 14px rgba(0,0,0,0.5);
    `;
    hud.innerHTML = `
      <div style="font-weight:bold;margin-bottom:3px">HiveStream ${VERSION}</div>
      <div>Status: <span id="hs-status">idle</span></div>
      <div>Swarm: <span id="hs-swarm">—</span></div>
      <div>Peers: <span id="hs-peers">0</span></div>
      <div>HTTP: <span id="hs-http">0 B</span></div>
      <div>P2P ↓: <span id="hs-p2p-down">0 B</span></div>
      <div style="color:#f88;font-size:11px;margin-top:4px" id="hs-error"></div>
      <button id="hs-copy" style="margin-top:6px;font-size:11px;padding:3px 8px">Copy log</button>
    `;
    document.body.appendChild(hud);

    document.getElementById('hs-copy').onclick = function () {
      const text = S.log.join('\n') + '\n\nStatus: ' + S.status + '\nError: ' + S.lastError;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
          this.textContent = 'Copied!';
          setTimeout(() => { this.textContent = 'Copy log'; }, 1500);
        });
      } else {
        // Fallback for older mobile
        prompt('Copy this log:', text);
      }
    };
  }

  function setStatus(text) {
    S.status = text;
    const el = document.getElementById('hs-status');
    if (el) el.textContent = text;
  }

  function setError(text) {
    S.lastError = text || '';
    const el = document.getElementById('hs-error');
    if (el) el.textContent = text || '';
  }

  function updateHUD() {
    const el = id => document.getElementById(id);
    if (!el('hs-peers')) return;
    el('hs-swarm').textContent = S.currentSwarmId ? S.currentSwarmId.slice(0, 16) + '…' : '—';
    el('hs-peers').textContent = S.peers;
    el('hs-http').textContent = formatBytes(S.httpBytes);
    el('hs-p2p-down').textContent = formatBytes(S.p2pDown);
  }

  // ── Take over #ytapiplayer ────────────────────────────────
  function getOrCreateVideo() {
    // Clear whatever CyTube currently has in the player slot
    let container = document.getElementById('ytapiplayer');
    if (!container) {
      // Fallback: try videowrap
      container = document.querySelector('#videowrap .embed-responsive') ||
                  document.getElementById('videowrap');
    }
    if (!container) {
      setError('No #ytapiplayer found');
      log('No player container found');
      return null;
    }

    // Remove existing children (YouTube iframe, old video, etc.)
    while (container.firstChild) {
      container.removeChild(container.firstChild);
    }

    const video = document.createElement('video');
    video.id = 'hs-video';
    video.controls = true;
    video.playsInline = true;          // critical for iOS/mobile
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.style.width = '100%';
    video.style.height = '100%';
    video.style.background = '#000';

    container.appendChild(video);
    S.video = video;
    log('Injected <video> into #ytapiplayer');
    return video;
  }

  // ── Load scripts ──────────────────────────────────────────
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector('script[src="' + src + '"]')) {
        return resolve();
      }
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Failed: ' + src));
      document.head.appendChild(s);
    });
  }

  // ── Main play function ────────────────────────────────────
  async function startPlay(url, swarmId) {
    ensureHUD();
    setError('');
    setStatus('starting…');
    log('startPlay', url, swarmId);

    S.currentUrl = url;
    S.currentSwarmId = swarmId || makeSwarmId(url);
    S.peers = 0;
    S.httpBytes = 0;
    S.p2pDown = 0;
    updateHUD();

    // 1. Get a clean video element
    const video = getOrCreateVideo();
    if (!video) return;

    // 2. Load hls.js
    try {
      setStatus('loading hls.js…');
      await loadScript('https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js');
    } catch (e) {
      setStatus('hls.js failed');
      setError(e.message);
      return;
    }

    if (typeof Hls === 'undefined') {
      setStatus('Hls missing');
      setError('Hls global not found');
      return;
    }

    // Destroy previous
    if (S.hls) {
      try { S.hls.destroy(); } catch (_) {}
      S.hls = null;
    }

    // 3. Plain hls.js first (most reliable on mobile)
    setStatus('creating player…');
    S.hls = new Hls({
      enableWorker: false,          // safer on mobile
      maxBufferLength: 30
    });

    S.hls.loadSource(url);
    S.hls.attachMedia(video);

    S.hls.on(Hls.Events.MANIFEST_PARSED, function () {
      setStatus('playing (http)');
      log('Manifest parsed');
      // Mobile often needs a user gesture – try anyway
      const p = video.play();
      if (p && p.catch) {
        p.catch(err => {
          setStatus('tap to play');
          setError('Autoplay blocked – tap the video');
          log('play() blocked', err.message);
        });
      }
    });

    S.hls.on(Hls.Events.ERROR, function (event, data) {
      if (data.fatal) {
        setStatus('error');
        setError(data.details || data.type || 'fatal');
        log('HLS fatal', data);
      }
    });

    // Optional: try to upgrade to P2P later (we can expand this)
    // For now we prioritize actually seeing video on mobile.
  }

  // ── Chat command handler ──────────────────────────────────
  function handleChat(data) {
    if (!data || !data.msg) return;
    const msg = data.msg.trim();
    if (!msg.startsWith(CFG.cmd)) return;

    log('chat command:', msg);

    const rest = msg.slice(CFG.cmd.length).trim();
    const parts = rest.split(/\s+/);
    const cmd = (parts[0] || '').toLowerCase();

    if (cmd === 'help') {
      chat(CFG.cmd + ' play <m3u8-url>');
      chat(CFG.cmd + ' swarm=<id> url=<m3u8>');
      return;
    }

    if (cmd === 'status') {
      chat('HS ' + S.status + ' peers=' + S.peers + ' err=' + (S.lastError || 'none'));
      return;
    }

    if (cmd === 'play' && parts[1]) {
      startPlay(parts[1]);
      return;
    }

    // key=value style
    let swarmId = null, url = null;
    parts.forEach(p => {
      if (p.startsWith('swarm=')) swarmId = p.slice(6);
      if (p.startsWith('url=')) url = p.slice(4);
    });

    if (url) {
      startPlay(url, swarmId);
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
    log('HiveStream', VERSION, 'loaded on', navigator.userAgent.slice(0, 60));

    if (window.socket) {
      socket.on('chatMsg', handleChat);
      log('socket already present');
    } else {
      let tries = 0;
      const t = setInterval(() => {
        if (window.socket) {
          clearInterval(t);
          socket.on('chatMsg', handleChat);
          log('socket attached after retries');
        } else if (++tries > 40) {
          clearInterval(t);
          setError('no socket');
        }
      }, 300);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
