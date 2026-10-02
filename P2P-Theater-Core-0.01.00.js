// ============================================================
// HiveStream / P2P-Theater-Core  v0.01.00
// "Swap the bytes, keep CyTube's player."
//
// What this does:
//   CyTube keeps playing a direct-mp4 ("fi") item with its own
//   Video.js player and its own sync. When the item's URL is in the
//   registry (URL -> .torrent that lists that same URL as a webseed),
//   we replace where the <video> gets its bytes from:
//       WebTorrent (webseed HTTP + WebRTC peers) -> MSE -> <video>
//   If anything fails or stalls, we put the original src back and
//   CyTube plays the plain mp4 exactly as before.
//
// Truth-telling HUD: HTTP vs P2P bytes are counted separately, and a
// "P2P PROOF" line only appears once real bytes arrived over a
// WebRTC wire.
//
// NOT done yet (on purpose): chat-based WebRTC signaling, TURN,
// playlist-wide prefetch, HLS. One change at a time.
// ============================================================
(function () {
  'use strict';

  var V = '0.01.00';
  if (window.__HS_VERSION === V) return;
  window.__HS_VERSION = V;

  // ── CONFIG ────────────────────────────────────────────────
  var CFG = {
    cmd: '!hs',
    wtSrc: 'https://cdn.jsdelivr.net/npm/webtorrent@1.9.7/webtorrent.min.js',
    trackers: [
      'wss://tracker.openwebtorrent.com',
      'wss://tracker.novage.com.ua',
      'wss://tracker.files.fm:7073/announce'
    ],
    // Put a TURN entry here when you have one, e.g.
    // { urls: 'turn:host:3478', username: 'u', credential: 'p' }
    iceServers: [
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun.nextcloud.com:443' }
    ],
    // CyTube usernames allowed to add mappings via "!hs map <mp4> <torrent>"
    admins: [],
    // mp4 URL -> .torrent URL (CORS-enabled, e.g. raw.githubusercontent.com)
    //          or a 40-char infohash (needs a live peer to serve metadata)
    registry: {
      // 'https://u.pone.rs/sahrrklr.mp4':
      //   'https://raw.githubusercontent.com/aolcyberchat-gpu/P2P-Theater-Core/main/torrents/sahrrklr.torrent'
    },
    videoWaitMs: 15000,   // wait for CyTube's <video> to exist
    startTimeoutMs: 25000 // no playable frames by then -> restore original src
  };

  // ── STATE ─────────────────────────────────────────────────
  var S = {
    wt: null, wtLoading: null, torrent: null, video: null,
    mediaUrl: null, origSrc: null, mode: 'idle', // idle|probing|metadata|buffering|p2p|fallback
    p2pDown: 0, p2pUp: 0, proof: false, proofPeer: null,
    trackerWarn: 0, token: 0, startTimer: null, hudTimer: null,
    myName: '', log: []
  };

  function log() {
    var a = Array.prototype.slice.call(arguments).map(function (x) {
      try { return typeof x === 'object' ? JSON.stringify(x) : String(x); } catch (e) { return String(x); }
    }).join(' ');
    S.log.push('[' + new Date().toLocaleTimeString() + '] ' + a);
    if (S.log.length > 200) S.log.shift();
    console.log('[HS ' + V + ']', a);
    var el = document.getElementById('hs-log');
    if (el) { el.textContent = S.log.slice(-12).join('\n'); }
  }
  function chat(msg) { if (window.socket) window.socket.emit('chatMsg', { msg: msg }); }
  function mb(n) { return (n / 1048576).toFixed(2) + ' MB'; }

  // ── HUD ───────────────────────────────────────────────────
  function ensureHUD() {
    if (document.getElementById('hs-hud')) return;
    var d = document.createElement('div');
    d.id = 'hs-hud';
    d.style.cssText = 'position:fixed;bottom:6px;left:6px;z-index:99999;background:rgba(0,0,0,.88);' +
      'color:#eee;padding:8px 10px;border-radius:8px;font:11px/1.35 monospace;max-width:270px;' +
      'box-shadow:0 4px 14px rgba(0,0,0,.5)';
    d.innerHTML =
      '<div style="font-weight:bold">HiveStream ' + V + '</div>' +
      '<div>mode: <b id="hs-mode">idle</b></div>' +
      '<div>peers(webrtc): <span id="hs-peers">0</span></div>' +
      '<div>HTTP(webseed)≈ <span id="hs-http">0</span></div>' +
      '<div>P2P ↓ <span id="hs-down">0</span> ↑ <span id="hs-up">0</span></div>' +
      '<div id="hs-proof" style="color:#6f6;margin-top:2px"></div>' +
      '<div id="hs-ih" style="color:#999;word-break:break-all"></div>' +
      '<pre id="hs-log" style="margin:4px 0 0;max-height:110px;overflow:auto;white-space:pre-wrap;color:#9cf;font-size:10px"></pre>' +
      '<div style="margin-top:4px">' +
      '<button id="hs-copy" style="font-size:10px">Copy log</button> ' +
      '<button id="hs-pub" style="font-size:10px">Make .torrent</button> ' +
      '<button id="hs-min" style="font-size:10px">_</button></div>';
    document.body.appendChild(d);
    document.getElementById('hs-copy').onclick = function () {
      var t = S.log.join('\n') + '\n' + JSON.stringify(snapshot());
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t);
      else prompt('Copy:', t);
    };
    document.getElementById('hs-pub').onclick = function () { publishCurrent(); };
    document.getElementById('hs-min').onclick = function () {
      var l = document.getElementById('hs-log');
      l.style.display = l.style.display === 'none' ? 'block' : 'none';
    };
  }
  function setMode(m) { S.mode = m; var e = document.getElementById('hs-mode'); if (e) e.textContent = m; log('mode ->', m); }
  function snapshot() {
    var t = S.torrent;
    var rtc = 0;
    if (t && t.wires) t.wires.forEach(function (w) { if (w.type !== 'webSeed') rtc++; });
    var total = t ? t.downloaded : 0;
    return {
      v: V, mode: S.mode, url: S.mediaUrl, infoHash: t && t.infoHash, webrtcWires: rtc,
      torrentDownloaded: total, p2pDown: S.p2pDown, p2pUp: S.p2pUp,
      httpApprox: Math.max(0, total - S.p2pDown), proof: S.proof, proofPeer: S.proofPeer,
      trackerWarnings: S.trackerWarn, progress: t ? t.progress : 0
    };
  }
  function updateHUD() {
    var s = snapshot(), $ = function (i) { return document.getElementById(i); };
    if (!$('hs-peers')) return;
    $('hs-peers').textContent = s.webrtcWires;
    $('hs-http').textContent = mb(s.httpApprox);
    $('hs-down').textContent = mb(s.p2pDown);
    $('hs-up').textContent = mb(s.p2pUp);
    $('hs-ih').textContent = s.infoHash ? 'ih ' + s.infoHash : '';
    $('hs-proof').textContent = s.proof ? 'P2P PROOF: bytes from ' + String(s.proofPeer).slice(0, 14) : '';
  }

  // ── helpers ───────────────────────────────────────────────
  function loadScript(src) {
    return new Promise(function (res, rej) {
      if (document.querySelector('script[src="' + src + '"]')) return res();
      var s = document.createElement('script');
      s.src = src; s.onload = function () { res(); };
      s.onerror = function () { rej(new Error('failed to load ' + src)); };
      document.head.appendChild(s);
    });
  }
  function getClient() {
    if (S.wt) return Promise.resolve(S.wt);
    if (S.wtLoading) return S.wtLoading;
    S.wtLoading = loadScript(CFG.wtSrc).then(function () {
      if (!window.WebTorrent) throw new Error('WebTorrent global missing');
      S.wt = new window.WebTorrent({ tracker: { rtcConfig: { iceServers: CFG.iceServers } } });
      S.wt.on('error', function (e) { log('client error', e && e.message || e); });
      return S.wt;
    });
    return S.wtLoading;
  }
  function findVideo() {
    return document.querySelector('#ytapiplayer video') || document.querySelector('#videowrap video');
  }
  function waitForVideo(token) {
    return new Promise(function (res, rej) {
      var t0 = Date.now();
      (function poll() {
        if (token !== S.token) return rej(new Error('superseded'));
        var v = findVideo();
        if (v) return res(v);
        if (Date.now() - t0 > CFG.videoWaitMs) return rej(new Error('no <video> in CyTube player'));
        setTimeout(poll, 250);
      })();
    });
  }
  // Cheap CORS/Range probe of the webseed URL (reports, never blocks)
  function probe(url) {
    return fetch(url, { headers: { Range: 'bytes=0-0' } }).then(function (r) {
      log('probe', r.status, 'content-range=' + r.headers.get('content-range'),
        'accept-ranges=' + r.headers.get('accept-ranges'));
      if (r.status !== 206) log('WARNING: server did not answer Range with 206 - webseed may be unusable');
      return r.body && r.body.cancel ? r.body.cancel() : null;
    }).catch(function (e) {
      log('probe FAILED (' + e.message + ') - likely CORS: webseed fetches from this page will fail');
    });
  }

  // ── teardown ──────────────────────────────────────────────
  function teardown(restore) {
    S.token++;
    if (S.startTimer) { clearTimeout(S.startTimer); S.startTimer = null; }
    if (S.torrent) { try { S.torrent.destroy(); } catch (e) {} S.torrent = null; }
    if (restore && S.video && S.origSrc && S.mode !== 'idle') restoreOriginal();
    S.p2pDown = 0; S.p2pUp = 0; S.proof = false; S.proofPeer = null; S.trackerWarn = 0;
  }
  function restoreOriginal() {
    var v = S.video; if (!v || !S.origSrc) return;
    var t = v.currentTime, wasPlaying = !v.paused;
    log('restoring original src');
    try { v.removeAttribute('src'); v.src = S.origSrc; v.load(); } catch (e) { log('restore err', e.message); }
    v.addEventListener('loadedmetadata', function once() {
      v.removeEventListener('loadedmetadata', once);
      try { if (t > 0) v.currentTime = t; if (wasPlaying) v.play().catch(function () {}); } catch (e) {}
    });
    setMode('fallback');
  }

  // ── attach P2P to the current CyTube video ────────────────
  function attach(url) {
    var token = ++S.token;
    if (S.torrent) { try { S.torrent.destroy(); } catch (e) {} S.torrent = null; }
    S.p2pDown = 0; S.p2pUp = 0; S.proof = false; S.proofPeer = null; S.trackerWarn = 0;
    S.mediaUrl = url;
    var source = CFG.registry[url];
    ensureHUD(); setMode('probing');
    log('attach', url, 'via', source);

    Promise.all([waitForVideo(token), getClient()]).then(function (r) {
      if (token !== S.token) return;
      var video = r[0], client = r[1];
      S.video = video;
      S.origSrc = video.currentSrc || video.getAttribute('src') || url;
      probe(url);
      setMode('metadata');

      var opts = { announce: CFG.trackers, urlList: [url] };
      var arg = /^[0-9a-f]{40}$/i.test(source)
        ? 'magnet:?xt=urn:btih:' + source + '&ws=' + encodeURIComponent(url) +
          CFG.trackers.map(function (t) { return '&tr=' + encodeURIComponent(t); }).join('')
        : source;
      var torrent = client.add(arg, opts);
      S.torrent = torrent;

      torrent.on('wire', function (wire) {
        log('wire', wire.type, String(wire.peerId || '').slice(0, 12));
        if (wire.type === 'webSeed') return; // webseed wires don't report bytes; HTTP is derived
        wire.on('download', function (n) {
          S.p2pDown += n;
          if (!S.proof) { S.proof = true; S.proofPeer = wire.peerId || wire.remoteAddress || '?'; log('P2P PROOF first bytes from', S.proofPeer); }
        });
        wire.on('upload', function (n) { S.p2pUp += n; });
      });
      torrent.on('warning', function (w) { S.trackerWarn++; if (S.trackerWarn <= 5) log('warn', w && w.message || w); });
      torrent.on('error', function (e) { log('torrent error', e && e.message || e); teardown(true); });

      torrent.on('metadata', function () {
        if (token !== S.token) return;
        // Safety: the torrent must be bound to this URL as a webseed.
        var ul = (torrent.urlList || []).map(String);
        if (ul.indexOf(url) < 0) { log('REFUSING torrent: its url-list does not contain', url); teardown(true); return; }
        var best = null;
        torrent.files.forEach(function (f) { if (!best || f.length > best.length) best = f; });
        if (!best || !/\.(mp4|m4v|mov)$/i.test(best.name)) { log('no mp4 in torrent'); teardown(true); return; }
        log('metadata ok', best.name, mb(best.length));
        startRender(token, video, best);
      });
    }).catch(function (e) {
      if (e && e.message === 'superseded') return;
      log('attach failed:', e && e.message || e);
      if (token === S.token) setMode('fallback');
    });
  }

  function startRender(token, video, file) {
    var t = video.currentTime || 0, wasPlaying = !video.paused;
    setMode('buffering');
    // stop the original HTTP download before taking over
    try { video.pause(); video.removeAttribute('src'); video.load(); } catch (e) {}

    var done = false;
    function ok() {
      if (done || token !== S.token) return; done = true;
      if (S.startTimer) { clearTimeout(S.startTimer); S.startTimer = null; }
      setMode('p2p-hybrid');
      try { if (t > 0) video.currentTime = t; if (wasPlaying) video.play().catch(function () {}); } catch (e) {}
    }
    video.addEventListener('canplay', ok, { once: true });
    S.startTimer = setTimeout(function () {
      if (done || token !== S.token) return;
      log('no playable data within', CFG.startTimeoutMs, 'ms');
      teardown(true);
    }, CFG.startTimeoutMs);

    try {
      file.renderTo(video, { autoplay: false }, function (err) {
        if (err) { log('renderTo error', err.message); if (token === S.token && !done) teardown(true); }
      });
    } catch (e) { log('renderTo threw', e.message); teardown(true); }
  }

  // ── "Make .torrent" for the item currently in CyTube ──────
  // Downloads the mp4 once, hashes it, offers the .torrent file.
  // (Commit that file to your repo and add it to CFG.registry.)
  function publishCurrent() {
    var url = (window.PLAYER && window.PLAYER.mediaId) || S.mediaUrl;
    if (!url || !/^https?:/.test(url)) { log('publish: no direct-URL media is playing'); return; }
    var name = decodeURIComponent(url.split('?')[0].split('/').pop() || 'video.mp4');
    log('publish: downloading', url);
    getClient().then(function (client) {
      return fetch(url).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.blob(); // Blob can stay disk-backed; no ArrayBuffer copy
      }).then(function (blob0) {
        log('publish: hashing', mb(blob0.size));
        var file = new File([blob0], name, { type: 'video/mp4' });
        client.seed(file, { name: name, announce: CFG.trackers, urlList: [url], pieceLength: 1 << 20 }, function (t) {
          log('publish: infohash', t.infoHash);
          var blob = new Blob([t.torrentFile], { type: 'application/x-bittorrent' });
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob); a.download = name.replace(/\.[^.]+$/, '') + '.torrent';
          document.body.appendChild(a); a.click(); a.remove();
          log('publish: .torrent downloaded. Map:', url, '->', '<url of committed .torrent>');
        });
      });
    }).catch(function (e) { log('publish failed:', e.message, '(CORS on a full GET? use the Termux route)'); });
  }

  // ── CyTube hooks ──────────────────────────────────────────
  function onChangeMedia(data) {
    if (!data) return;
    teardown(false);
    S.mode = 'idle';
    if (data.type === 'fi' && CFG.registry[data.id]) attach(data.id);
    else { var m = document.getElementById('hs-mode'); if (m) m.textContent = 'idle (no mapping)'; }
  }
  function onChat(d) {
    if (!d || !d.msg) return;
    var m = String(d.msg).trim();
    if (m.indexOf(CFG.cmd + ' ') !== 0) return;
    var p = m.slice(CFG.cmd.length + 1).trim().split(/\s+/);
    // Announcements are idempotent data, so history replays are fine.
    if (p[0] === 'map' && p[1] && p[2] && CFG.admins.indexOf(d.username) >= 0) {
      CFG.registry[p[1]] = p[2];
      log('mapped', p[1], '->', p[2], 'by', d.username);
      if (window.PLAYER && window.PLAYER.mediaId === p[1] && S.mode === 'idle') attach(p[1]);
    } else if (p[0] === 'status' && d.username === S.myName) {
      chat('HS ' + V + ' ' + JSON.stringify(snapshot()));
    }
  }

  function init() {
    ensureHUD();
    setInterval(function () { if (S.torrent) updateHUD(); }, 1000);
    var tries = 0;
    var t = setInterval(function () {
      if (window.socket) {
        clearInterval(t);
        S.myName = (window.CLIENT && window.CLIENT.name) || '';
        window.socket.on('changeMedia', function (d) { setTimeout(function () { onChangeMedia(d); }, 0); });
        window.socket.on('chatMsg', onChat);
        log('hooked socket');
        var cur = window.PLAYER;
        if (cur && cur.mediaType === 'fi' && CFG.registry[cur.mediaId]) attach(cur.mediaId);
      } else if (++tries > 60) { clearInterval(t); log('no socket'); }
    }, 300);
    log('loaded', navigator.userAgent.slice(0, 50));
  }
  window.HiveStream = { version: V, cfg: CFG, state: S, snapshot: snapshot, attach: attach, publish: publishCurrent };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
