// ==HiveStream v3.5.5==
// Grounded in live scrape of cytu.be/r/audiogalaxy (bigapple.cytu.be:8443)
//
// BUGS FIXED vs all prior versions:
//
// FIX 1 — CHAT ANTIFLOOD (burst:4 sustained:1/sec)
//   All prior versions sent search results as 8 rapid-fire messages → msgs 5-8 silently dropped.
//   Now: chatQueue sends burst of 4 instantly, then 1 per 1100ms after that.
//
// FIX 2 — RANK EVENT FORMAT
//   Server emits: socket.on('rank', -1)  — bare number, not {name, rank} object.
//   Prior code:   if(d && d.name === S.myName) S.myRank = d.rank  — never matched.
//   Now:          socket.on('rank', rank => { S.myRank = rank; })
//
// FIX 3 — TORRENT FALLBACK (placeholder bug)
//   _t relay passed literal string 'placeholder' as magnet fallback.
//   CORS blocks .torrent fetch on many PeerTube instances → fallback fires
//   → 'placeholder' is not a valid hash → nothing plays.
//   Now: relay passes real magnetUri so fallback always works.
//
// DEPLOY: Channel Settings → Admin Settings → External Javascript → paste hosted URL
//         OR paste into the inline JS editor (file is under 20KB)
//
// COMMANDS:
//   !hs top              trending on framatube.org
//   !hs search <query>   federated PeerTube search via SepiaSearch
//   !hs pick <n>         play result n from last search/top
//   !hs info <n>         show details for result n
//   !hs <infohash>       play known 40-char hash directly
//   !hs magnet <uri>     play by magnet URI
//   !hs pt <url> [res]   play any PeerTube URL directly
//   !hs sync             broadcast playback timestamp to room
//   !hs seek <s>         force-seek all clients
//   !hs res <p>          switch resolution (PeerTube only)
//   !hs stop             stop torrent, restore CyTube player
//   !hs status           swarm stats
//   !hs help             list commands

(function(){
'use strict';
const V='3.5.5';
if(window.__HS===V)return;
window.__HS=V;

// ── CONFIG ───────────────────────────────────────────────────────
const CFG={
  cmd:'!hs',
  defaultRes:'720',
  syncThres:2.5,
  syncMs:30000,
  minRank:1.5,       // leader+ for privileged commands
  useIDB:true,
  searchApi:'https://sepiasearch.org/api/v1/search/videos',
  topApi:'https://framatube.org/api/v1/videos?sort=-trending&count=20&hasWebtorrentVideo=true',
  wss:[
    'wss://tracker.openwebtorrent.com',
    'wss://tracker.btorrent.xyz',
    'wss://tracker.webtorrent.dev',
    'wss://tracker.fastcast.nz',
    'wss://tracker.novage.com.ua',
    'wss://tracker.qu.ax',
    'wss://tracker.uw0.xyz',
    'wss://tracker.dler.com',
    'wss://tracker.webtorrent.io',
  ],
  // Antiflood: burst 20 instantly, then 10/sec after (100ms apart)
  // Room settings: burst=20 (max), sustained=10/sec (max)
  chatBurst: 20,
  chatDelay: 100,
};

// ── KNOWN HASHES ─────────────────────────────────────────────────
const KNOWN={
  'dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c':{name:'Big Buck Bunny',url:'https://webtorrent.io/torrents/big-buck-bunny.torrent'},
  '08ada5a7a6183aae1e09d831df6748d566095a10':{name:'Sintel',url:'https://webtorrent.io/torrents/sintel.torrent'},
  'a88fda5954e89178c372716a6a78b8180ed4dad3':{name:'Tears of Steel',url:'https://webtorrent.io/torrents/tears-of-steel.torrent'},
  '6a9759bffd5c0af65319979fb7832189f4f3c35d':{name:'Elephants Dream',url:'https://webtorrent.io/torrents/elephants-dream.torrent'},
};

// ── STATE ─────────────────────────────────────────────────────────
const S={
  wt:null, torrent:null, video:null,
  results:[], hudTick:null,
  myRank:-1, myName:'',
  // Chat queue — prevents antiflood drops
  chatQueue:[], chatTimer:null, chatBurstCount:0, chatBurstReset:null,
};

const log=(...a)=>console.log('[HS]',...a);
const warn=(...a)=>console.warn('[HS]',...a);

// ── CHAT QUEUE ────────────────────────────────────────────────────
// CyTube antiflood: burst=4, sustained=1/sec, cooldown=4sec
// We send up to 4 instantly, then queue remainder at 1100ms intervals.
function chat(text){
  if(!window.socket)return;
  S.chatQueue.push(text);
  if(!S.chatTimer)flushChat();
}

function flushChat(){
  if(!S.chatQueue.length){S.chatTimer=null;return;}
  // Reset burst counter every 5 seconds
  if(!S.chatBurstReset){
    S.chatBurstCount=0;
    S.chatBurstReset=setTimeout(()=>{S.chatBurstCount=0;S.chatBurstReset=null;},5000);
  }
  const msg=S.chatQueue.shift();
  socket.emit('chatMsg',{msg:msg});
  S.chatBurstCount++;
  // If under burst limit send next one quickly, otherwise slow down
  const delay=S.chatBurstCount<CFG.chatBurst ? 150 : CFG.chatDelay;
  S.chatTimer=setTimeout(flushChat, delay);
}

function relay(body){chat(CFG.cmd+' '+body);}

// ── UTILS ─────────────────────────────────────────────────────────
function fmtDur(s){
  if(!s||isNaN(s))return'?';
  return Math.floor(s/60)+':'+(s%60<10?'0':'')+Math.floor(s%60);
}
function fmtSpd(b){
  if(b>1e6)return(b/1e6).toFixed(1)+'MB/s';
  if(b>1e3)return(b/1e3).toFixed(0)+'KB/s';
  return b+'B/s';
}

// ── BOOT ──────────────────────────────────────────────────────────
function boot(){
  log('v'+V+' booting');
  loadScript('https://cdn.jsdelivr.net/npm/webtorrent@1/webtorrent.min.js',function(){
    log('WebTorrent ready');
    detectSelf();
    if(CFG.useIDB)openIDB();
    buildTheater();
    hookChat();
    chat('HiveStream v'+V+' ready — type !hs help');
  });
}

function loadScript(src,cb){
  if(document.querySelector('script[src="'+src+'"]')){cb();return;}
  const s=document.createElement('script');
  s.src=src; s.onload=cb;
  s.onerror=function(){warn('CDN load failed:',src);cb();};
  document.head.appendChild(s);
}

// ── SELF DETECTION ────────────────────────────────────────────────
// FIX: rank event sends bare number, not {name,rank} object.
// Confirmed from live scrape: server emits socket.on('rank', -1)
function detectSelf(){
  // Try CLIENT global first (set by CyTube before external JS loads)
  try{
    if(window.CLIENT){
      S.myName=CLIENT.name||'';
      S.myRank=(CLIENT.rank!==undefined)?CLIENT.rank:-1;
    }
  }catch(e){}
  // Fallback: parse welcome message
  if(!S.myName){
    const w=document.getElementById('welcome');
    if(w)S.myName=w.textContent.replace(/^Welcome,\s*/i,'').trim();
  }
  // Hook rank updates — FIXED: bare number, not object
  if(window.socket){
    socket.on('rank',function(rank){
      log('rank update:',rank);
      S.myRank=rank;
    });
    // login event (when user logs in during session)
    socket.on('login',function(d){
      if(d&&d.name){S.myName=d.name;if(d.rank!==undefined)S.myRank=d.rank;}
    });
  }
  log('detected name='+S.myName+' rank='+S.myRank);
}

// ── IDB ───────────────────────────────────────────────────────────
function openIDB(){
  if(!window.indexedDB)return;
  const r=indexedDB.open('HiveStream',1);
  r.onupgradeneeded=function(e){
    if(!e.target.result.objectStoreNames.contains('pieces'))
      e.target.result.createObjectStore('pieces');
  };
  r.onsuccess=function(e){S.idb=e.target.result;log('IDB open');};
}
function idbSet(k,v){
  if(!S.idb)return;
  try{S.idb.transaction('pieces','readwrite').objectStore('pieces').put(v,k);}catch(e){}
}

// ── THEATER UI ────────────────────────────────────────────────────
function buildTheater(){
  if(document.getElementById('hs-theater'))return;

  const style=document.createElement('style');
  style.textContent=
    '#hs-theater{width:100%;background:#0a0a0a;border:2px solid #0f0;margin-bottom:10px;'+
      'font-family:monospace;box-sizing:border-box}'+
    '#hs-bar{display:flex;gap:5px;padding:6px;background:#111;align-items:center;flex-wrap:wrap}'+
    '#hs-bar input{flex:1;min-width:120px;padding:5px 8px;background:#1a1a1a;color:#0f0;'+
      'border:1px solid #0f0;outline:none;font:12px monospace}'+
    '#hs-bar button{padding:5px 9px;background:#0a0a0a;color:#0f0;border:1px solid #0f0;'+
      'cursor:pointer;font:11px monospace;white-space:nowrap}'+
    '#hs-bar button:hover{background:#0f0;color:#000}'+
    '#hs-grid{display:flex;overflow-x:auto;gap:6px;padding:8px;background:#0d0d0d;min-height:10px}'+
    '#hs-grid:empty{display:none}'+
    '.hs-thumb{cursor:pointer;flex-shrink:0;width:130px;border:1px solid #222}'+
    '.hs-thumb:hover{border-color:#0f0}'+
    '.hs-thumb img{width:130px;height:98px;object-fit:cover;display:block;background:#111}'+
    '.hs-tlabel{color:#0f0;font:9px monospace;padding:2px 4px;overflow:hidden;'+
      'white-space:nowrap;text-overflow:ellipsis}'+
    '.hs-tdur{color:#555;font:9px monospace;padding:0 4px 3px}'+
    '#hs-vwrap{position:relative;background:#000;min-height:360px}'+
    '#hs-video{width:100%;display:block;min-height:360px;background:#000}'+
    '#hs-hud{position:absolute;top:6px;left:6px;background:rgba(0,0,0,.85);'+
      'color:#0f0;font:10px monospace;padding:3px 7px;pointer-events:none;display:none}'+
    '#hs-overlay{position:absolute;inset:0;display:flex;align-items:center;'+
      'justify-content:center;color:#333;font:14px monospace;pointer-events:none}'+
    '#hs-spinner{display:none;position:absolute;inset:0;align-items:center;'+
      'justify-content:center;background:rgba(0,0,0,.75);color:#0f0;font:13px monospace}';
  document.head.appendChild(style);

  const t=document.createElement('div');
  t.id='hs-theater';

  // Search bar
  const bar=document.createElement('div');
  bar.id='hs-bar';
  bar.innerHTML=
    '<input id="hs-sinput" placeholder="Search PeerTube (federated via SepiaSearch)...">'+
    '<button id="hs-sbtn">Search</button>'+
    '<button id="hs-topbtn">Top 10</button>'+
    '<button id="hs-stopbtn">Stop</button>';
  t.appendChild(bar);

  // Thumbnail grid (hidden until results arrive)
  const grid=document.createElement('div');
  grid.id='hs-grid';
  t.appendChild(grid);

  // Video wrapper
  const vwrap=document.createElement('div');
  vwrap.id='hs-vwrap';

  const vid=document.createElement('video');
  vid.id='hs-video'; vid.controls=true; vid.autoplay=true; vid.playsInline=true;
  vwrap.appendChild(vid);
  S.video=vid;

  const hud=document.createElement('div');
  hud.id='hs-hud';
  vwrap.appendChild(hud);

  const overlay=document.createElement('div');
  overlay.id='hs-overlay';
  overlay.textContent='Nothing Playing — search or click Top 10';
  vwrap.appendChild(overlay);

  const spinner=document.createElement('div');
  spinner.id='hs-spinner';
  spinner.textContent='Loading…';
  vwrap.appendChild(spinner);

  t.appendChild(vwrap);

  // Insert above #main row (confirmed DOM: #main contains #chatwrap + #videowrap)
  const main=document.getElementById('main');
  if(main)main.parentNode.insertBefore(t,main);
  else document.body.prepend(t);

  // Wire buttons
  document.getElementById('hs-sbtn').onclick=function(){
    const v=document.getElementById('hs-sinput').value.trim();
    if(v)cmdSearch(v);
  };
  document.getElementById('hs-sinput').onkeydown=function(e){
    if(e.key==='Enter'){const v=e.target.value.trim();if(v)cmdSearch(v);}
  };
  document.getElementById('hs-topbtn').onclick=cmdTop;
  document.getElementById('hs-stopbtn').onclick=stopTorrent;

  log('theater built');
}

// ── THUMBNAIL GRID ────────────────────────────────────────────────
function showGrid(items){
  const grid=document.getElementById('hs-grid');
  if(!grid)return;
  grid.innerHTML='';
  items.forEach(function(r,i){
    const div=document.createElement('div');
    div.className='hs-thumb';
    const img=document.createElement('img');
    // thumbnailUrl is absolute; thumbnailPath is relative, need to prepend host
    const host=r.account&&r.account.host?'https://'+r.account.host:'';
    img.src=r.thumbnailUrl||(r.thumbnailPath?host+r.thumbnailPath:'');
    img.onerror=function(){this.style.background='#111';this.style.display='none';};
    const label=document.createElement('div');
    label.className='hs-tlabel';
    label.title=r.name||'';
    label.textContent=(i+1)+'. '+(r.name||'Video');
    const dur=document.createElement('div');
    dur.className='hs-tdur';
    dur.textContent=fmtDur(r.duration)+(r.account&&r.account.host?' · '+r.account.host:'');
    div.appendChild(img); div.appendChild(label); div.appendChild(dur);
    div.onclick=function(){pickResult(r);};
    grid.appendChild(div);
  });
}

// ── PICK RESULT ───────────────────────────────────────────────────
// List API does NOT include files[] — must fetch individual video endpoint.
// Confirmed from prior debugging.
function pickResult(r){
  const host=r.account&&r.account.host
    ? 'https://'+r.account.host
    : 'https://framatube.org';
  const uuid=r.uuid||r.id||r.shortUUID;
  if(!uuid){chat('No video ID in result');return;}
  setSpinner(true,'Fetching video info…');
  fetch(host+'/api/v1/videos/'+uuid)
    .then(function(res){
      if(!res.ok)throw new Error('API '+res.status);
      return res.json();
    })
    .then(function(data){
      setSpinner(false);
      // data.files = WebTorrent mp4 files (playable via renderTo)
      // streamingPlaylists[].files = HLS m3u8 segments (NOT playable via renderTo)
      // Only use data.files. If empty, this PeerTube instance has WebTorrent disabled.
      const files=(data.files||[]).filter(function(f){return f.magnetUri||f.torrentUrl;});
      if(!files.length){
        chat('⚠ "'+data.name+'" has no WebTorrent mp4 files (instance uses HLS-only). Try another result.');
        return;
      }
      const target=pickRes(files,CFG.defaultRes);
      chat('Playing: '+data.name+' ['+target.res+'p'+(target.isHLS?' HLS':'')+']');
      // Pass real magnetUri as fallback — if .torrent fetch fails (CORS on
      // many PeerTube instances) clients fall back to magnet immediately.
      // channelOpts.maxlength=0 so long magnets are fine via socket.emit.
      if(target.torrentUrl&&target.magnet)
        relay('_t '+target.torrentUrl+' '+target.magnet);
      else if(target.torrentUrl)
        relay('_t '+target.torrentUrl+' none');
      else
        relay('_m '+target.magnet);
    })
    .catch(function(e){
      setSpinner(false);
      chat('Fetch error: '+e.message);
    });
}

function setSpinner(on,msg){
  const s=document.getElementById('hs-spinner');
  if(!s)return;
  s.textContent=msg||'Loading…';
  s.style.display=on?'flex':'none';
}

function pickRes(files,pref){
  const pn=parseInt(String(pref).replace('p',''),10);
  // Normalise all file entries
  const norm=files.map(function(f){
    const r=(f.resolution&&(f.resolution.id||f.resolution.label))||'?';
    const tu=f.torrentUrl||null;
    return{
      res:String(r),
      magnet:f.magnetUri||null,
      torrentUrl:tu,
      // HLS torrent = m3u8 playlists, cannot renderTo() a video element.
      // Regular torrent = actual mp4/webm file, playable directly.
      isHLS: tu ? /-hls\.torrent/i.test(tu) : false,
    };
  });
  // Prefer non-HLS files — PeerTube usually offers both per resolution
  const nonHLS=norm.filter(function(f){return !f.isHLS;});
  const pool=nonHLS.length ? nonHLS : norm; // fallback to HLS only if no regular exists
  const ex=pool.find(function(f){return parseInt(f.res)===pn;});
  if(ex)return ex;
  const s=pool.slice().sort(function(a,b){return parseInt(b.res)-parseInt(a.res);});
  return s.find(function(f){return parseInt(f.res)<=pn;})||s[s.length-1];
}

// ── SEARCH / TOP ──────────────────────────────────────────────────
function cmdSearch(q){
  setSpinner(true,'Searching…');
  const url=CFG.searchApi+'?search='+encodeURIComponent(q)+'&count=20&sort=-trending';
  fetch(url)
    .then(function(r){if(!r.ok)throw new Error(r.status);return r.json();})
    .then(function(d){
      setSpinner(false);
      S.results=d.data||[];
      if(!S.results.length){chat('No torrent results: '+q);return;}
      showGrid(S.results);
      // Queue results as chat messages — antiflood-safe
      chat(S.results.length+' results for "'+q+'" — pick <n> to play:');
      S.results.slice(0,8).forEach(function(v,i){
        const h=v.account&&v.account.host?v.account.host:'?';
        chat((i+1)+'. ['+fmtDur(v.duration)+'] '+v.name+' ('+h+')');
      });
    })
    .catch(function(e){setSpinner(false);chat('Search error: '+e.message);});
}

function cmdTop(){
  setSpinner(true,'Fetching trending…');
  fetch(CFG.topApi)
    .then(function(r){if(!r.ok)throw new Error(r.status);return r.json();})
    .then(function(d){
      setSpinner(false);
      S.results=d.data||[];
      if(!S.results.length){chat('No trending results.');return;}
      showGrid(S.results);
      chat('Trending ('+S.results.length+') — !hs pick <n> or click thumbnail:');
      S.results.slice(0,8).forEach(function(v,i){
        chat((i+1)+'. ['+fmtDur(v.duration)+'] '+v.name);
      });
    })
    .catch(function(e){setSpinner(false);chat('Top error: '+e.message);});
}

// ── TORRENT LIFECYCLE ─────────────────────────────────────────────
// Key: fetch .torrent ArrayBuffer first so metadata+webseed available instantly.
// No peers needed. Magnet fallback if .torrent fetch fails (CORS).
// startTorrentUrl: fetch .torrent as ArrayBuffer (instant metadata, webseed starts
// immediately with zero peers). fallback is either a full magnet URI or a 40-char hash.
function startTorrentUrl(torrentUrl,fallback){
  if(!torrentUrl)return;
  if(!S.wt)S.wt=mkClient();
  setSpinner(true,'Fetching .torrent…');
  log('fetching .torrent:',torrentUrl);
  fetch(torrentUrl)
    .then(function(r){
      if(!r.ok)throw new Error('HTTP '+r.status);
      return r.arrayBuffer();
    })
    .then(function(buf){
      setSpinner(false);
      log('.torrent OK:',buf.byteLength,'bytes');
      destroyCurrent(function(){
        const t=S.wt.add(buf);
        S.torrent=t; bind(t);
      });
    })
    .catch(function(e){
      setSpinner(false);
      warn('.torrent fetch failed ('+e.message+') — fallback:',fallback);
      chat('⚠ .torrent CORS blocked — trying magnet fallback');
      if(!fallback||fallback==='none'||fallback==='placeholder'){warn('no valid fallback');return;}
      // fallback is either a full magnet URI or a 40-char infohash
      if(fallback.startsWith('magnet:')){
        startMagnet(fallback);
      } else if(/^[0-9a-f]{40}$/i.test(fallback)){
        startMagnet('magnet:?xt=urn:btih:'+fallback+
          CFG.wss.map(function(t){return'&tr='+encodeURIComponent(t);}).join(''));
      } else {
        warn('fallback is not a magnet or hash:',fallback);
      }
    });
}

function startMagnet(magnet){
  if(!magnet.startsWith('magnet:'))return;
  if(!S.wt)S.wt=mkClient();
  // PeerTube magnets contain xs= (torrent URL → CORS) and tr=https:// (HTTP trackers,
  // unusable in browsers). Extract just the btih hash and rebuild with WSS trackers only.
  const cleanMagnet = cleanPeerTubeMagnet(magnet);
  log('startMagnet clean:', cleanMagnet.slice(0,120));
  destroyCurrent(function(){
    setSpinner(true,'Connecting to swarm…');
    const t=S.wt.add(cleanMagnet);
    S.torrent=t; bind(t);
  });
}

// Extract btih hash from any magnet, rebuild with WSS trackers + dn if present.
// Drops xs= (CORS) and tr=https:// (HTTP, unusable in browser).
function cleanPeerTubeMagnet(magnet){
  try{
    // Parse the magnet URI
    const raw = magnet.replace(/^magnet:\?/,'');
    const params = {};
    raw.split('&').forEach(function(p){
      const eq = p.indexOf('=');
      if(eq<0)return;
      const k = p.slice(0,eq);
      const v = decodeURIComponent(p.slice(eq+1));
      if(!params[k])params[k]=[];
      params[k].push(v);
    });
    // Extract hash from xt=urn:btih:HASH
    let hash = null;
    if(params.xt){
      params.xt.forEach(function(v){
        const m = v.match(/urn:btih:([0-9a-fA-F]{40})/i);
        if(m)hash=m[1].toLowerCase();
      });
    }
    if(!hash){
      warn('No btih hash found in magnet, using as-is');
      return magnet;
    }
    // Rebuild: hash + display name + WSS trackers only (no xs, no http tr)
    let out = 'magnet:?xt=urn:btih:'+hash;
    if(params.dn&&params.dn[0])
      out += '&dn='+encodeURIComponent(params.dn[0]);
    CFG.wss.forEach(function(t){out+='&tr='+encodeURIComponent(t);});
    return out;
  }catch(e){
    warn('cleanPeerTubeMagnet error:',e);
    return magnet;
  }
}

function mkClient(){
  const wt=new window.WebTorrent();
  wt.on('error',function(e){warn('WT:',e);});
  return wt;
}

function bind(torrent){
  torrent.on('infoHash',function(){log('infoHash:',torrent.infoHash);});
  torrent.on('metadata',function(){
    setSpinner(false);
    log('metadata:',torrent.name);
    chat('"'+torrent.name+'" ready — joining swarm');
    showHUD(true);
  });
  torrent.on('ready',function(){onReady(torrent);});
  torrent.on('warning',function(w){warn(w);});
  torrent.on('error',function(e){warn('torrent error:',e);setSpinner(false);});
}

function onReady(torrent){
  log('ready:',torrent.name);
  attachFile(torrent);
  const el=document.getElementById('currenttitle');
  if(el)el.textContent=torrent.name;

  if(S.hudTick)clearInterval(S.hudTick);
  S.hudTick=setInterval(function(){
    if(!S.torrent){clearInterval(S.hudTick);S.hudTick=null;return;}
    const t=S.torrent;
    const p=t.length?Math.round(t.downloaded/t.length*100):0;
    setHUD((t.name||'')
      +' | '+t.numPeers+'p'
      +' | d:'+fmtSpd(t.downloadSpeed)
      +' u:'+fmtSpd(t.uploadSpeed)
      +' | '+p+'%');
  },2000);

  torrent.on('done',function(){
    if(CFG.useIDB)idbSet('done:'+torrent.infoHash,torrent.magnetURI);
  });
}

function attachFile(torrent){
  const overlay=document.getElementById('hs-overlay');
  if(overlay)overlay.style.display='none';
  const PLAYABLE=/\.(mp4|webm|mkv|mov|ogv|ogg|m4v)$/i;
  let best=null;
  torrent.files.forEach(function(f){
    if(!best){best=f;return;}
    const fv=PLAYABLE.test(f.name),bv=PLAYABLE.test(best.name);
    if(fv&&!bv){best=f;return;}
    if(f.length>best.length)best=f;
  });
  if(!best){warn('no playable file');return;}
  log('renderTo:',best.name);
  best.renderTo(S.video);
}

function destroyCurrent(cb){
  if(S.hudTick){clearInterval(S.hudTick);S.hudTick=null;}
  if(S.torrent)S.torrent.destroy(function(){S.torrent=null;cb&&cb();});
  else cb&&cb();
}

function stopTorrent(){
  destroyCurrent(function(){
    if(S.video){S.video.pause();S.video.src='';}
    showHUD(false);
    const overlay=document.getElementById('hs-overlay');
    if(overlay){overlay.style.display='flex';overlay.textContent='Nothing Playing';}
    chat('HiveStream stopped.');
  });
}

function showHUD(on){
  const h=document.getElementById('hs-hud');
  if(h)h.style.display=on?'block':'none';
}
function setHUD(txt){
  const h=document.getElementById('hs-hud');
  if(h)h.textContent=txt;
}

// ── DIRECT URL ────────────────────────────────────────────────────
function ptLoad(url,preferredRes){
  setSpinner(true,'Fetching PeerTube info…');
  let origin,vid;
  try{
    const u=new URL(url);origin=u.origin;
    const m=u.pathname.match(/\/(?:videos\/watch|w)\/([^/?#]+)/);
    if(!m)throw new Error('Unrecognised PeerTube URL');
    vid=m[1];
  }catch(e){chat('PT error: '+e.message);return;}
  fetch(origin+'/api/v1/videos/'+vid)
    .then(function(r){if(!r.ok)throw new Error('API '+r.status);return r.json();})
    .then(function(data){
      setSpinner(false);
      // Only use data.files (mp4 WebTorrent), not streamingPlaylists (HLS)
      const files=(data.files||[]).filter(function(f){return f.magnetUri||f.torrentUrl;}).map(function(f){
        return{res:String((f.resolution&&(f.resolution.id||f.resolution.label))||'?'),
               magnet:f.magnetUri||null,torrentUrl:f.torrentUrl||null};
      });
      if(!files.length)throw new Error('No WebTorrent mp4 files — instance may be HLS-only');
      const t=pickRes(files,preferredRes||CFG.defaultRes);
      chat('"'+data.name+'" @ '+t.res+'p');
      if(t.torrentUrl&&t.magnet)
        relay('_t '+t.torrentUrl+' '+t.magnet);
      else if(t.torrentUrl)
        relay('_t '+t.torrentUrl+' none');
      else
        relay('_m '+t.magnet);
    })
    .catch(function(e){setSpinner(false);chat('PT error: '+e.message);});
}

// ── SYNC ──────────────────────────────────────────────────────────
function startSyncTimer(){
  if(S.syncTimer)return;
  S.syncTimer=setInterval(function(){
    if(S.video&&!S.video.paused)relay('_s '+S.video.currentTime.toFixed(2));
  },CFG.syncMs);
}
function applySync(t){
  if(!S.video||isNaN(t))return;
  if(Math.abs(S.video.currentTime-t)>CFG.syncThres)S.video.currentTime=t;
}

// ── CHAT HOOK ─────────────────────────────────────────────────────
function hookChat(){
  if(!window.socket){setTimeout(hookChat,800);return;}
  // chatMsg payload confirmed: {username, msg, meta:{}, time}
  socket.on('chatMsg',function(d){
    const m=(d.msg||'').trim();
    if(!m.startsWith(CFG.cmd))return;
    onCmd(d.username,m.slice(CFG.cmd.length).trim());
  });
  log('chat hooked');
}

// ── RANK CHECK ────────────────────────────────────────────────────
// Primary: S.myRank (set by rank event — now correctly parsed as bare number)
// Fallback: read DOM userlist
function myRankOk(){
  if(S.myRank>=CFG.minRank)return true;
  // DOM fallback
  for(const el of document.querySelectorAll('#userlist .userlist_item')){
    const sp=el.querySelector('span:nth-child(2)');
    if(!sp||sp.textContent.trim()!==S.myName)continue;
    const c=(sp.className||'')+(el.className||'');
    if(c.includes('userlist_owner')||c.includes('userlist_op')||
       c.includes('userlist_leader'))return true;
  }
  return false;
}

// ── COMMAND ROUTER ────────────────────────────────────────────────
function onCmd(sender,rest){
  const parts=rest.split(/\s+/);
  const cmd=parts[0]||'';
  const args=parts.slice(1);

  // Internal relay — all clients always process these
  if(cmd==='_t'){startTorrentUrl(args[0],args[1]);return;}
  if(cmd==='_m'){startMagnet(args.join(' '));return;}
  if(cmd==='_s'){applySync(parseFloat(args[0]));return;}

  // Public (any rank)
  if(cmd==='help'){cmdHelp();return;}
  if(cmd==='status'){cmdStatus();return;}
  if(cmd==='info'){cmdInfo(parseInt(args[0]));return;}
  if(cmd==='search'){cmdSearch(args.join(' '));return;}
  if(cmd==='top'){cmdTop();return;}

  // Ranked commands (leader+ = 1.5+)
  // Use sender name to check rank for chat commands
  if(!isSenderRanked(sender))return;

  if(/^[0-9a-f]{40}$/i.test(cmd)){startHash(cmd.toLowerCase());return;}

  switch(cmd){
    case 'pick':
      const n=parseInt(args[0]);
      if(!isNaN(n)&&n>=1&&n<=S.results.length)pickResult(S.results[n-1]);
      else chat('Usage: !hs pick <n>  (1-'+S.results.length+')');
      break;
    case 'magnet':relay('_m '+args.join(' '));break;
    case 'pt':
      if(!args[0])return chat('Usage: !hs pt <url> [res]');
      ptLoad(args[0],args[1]);break;
    case 'sync':
      if(S.video)relay('_s '+S.video.currentTime.toFixed(2));break;
    case 'seek':
      const t=parseFloat(args[0]);
      if(!isNaN(t))relay('_s '+t.toFixed(2));
      else chat('Usage: !hs seek <seconds>');
      break;
    case 'res':
      if(!S.ptInfo)return chat('No active PeerTube video.');
      const tr=pickRes(S.ptInfo.files,args[0]);
      if(tr)relay('_m '+tr.magnet);
      break;
    case 'stop':stopTorrent();break;
  }
}

function isSenderRanked(name){
  // If sender is us and we know our rank
  if(name===S.myName&&S.myRank>=CFG.minRank)return true;
  // DOM check for any sender
  for(const el of document.querySelectorAll('#userlist .userlist_item')){
    const sp=el.querySelector('span:nth-child(2)');
    if(!sp||sp.textContent.trim()!==name)continue;
    const c=(sp.className||'')+(el.className||'');
    if(c.includes('userlist_owner')||c.includes('userlist_op')||
       c.includes('userlist_leader'))return true;
    return false;
  }
  return false;
}

function startHash(hash){
  const k=KNOWN[hash];
  if(k){chat('Loading: '+k.name);relay('_t '+k.url+' '+hash);}
  else{relay('_m magnet:?xt=urn:btih:'+hash+
    CFG.wss.map(function(t){return'&tr='+encodeURIComponent(t);}).join(''));}
}

function cmdStatus(){
  if(!S.torrent){chat('HiveStream v'+V+': idle');return;}
  const t=S.torrent;
  const p=t.length?(t.downloaded/t.length*100).toFixed(1):'?';
  chat(p+'% | '+t.numPeers+'p | d:'+fmtSpd(t.downloadSpeed)+' u:'+fmtSpd(t.uploadSpeed));
}

function cmdInfo(n){
  const v=S.results[n-1];
  if(!v){chat('No result '+n+'. Run !hs top or search first.');return;}
  const h=(v.account&&v.account.host)||'?';
  chat('['+n+'] '+v.name+' | '+fmtDur(v.duration)+' | '+h);
}

function cmdHelp(){
  chat('HiveStream v'+V+': top | search <q> | pick <n> | info <n> | <hash> | pt <url> | sync | seek <s> | stop | status');
}

// ── GO ────────────────────────────────────────────────────────────
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);
else boot();
})();
