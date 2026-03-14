// ==HiveStream v3.5.13==
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
const V='3.5.13';
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
// ws = HTTP webseed URL — allows download with zero WebRTC peers (pure HTTP)
// These are the official webseed URLs from the webtorrent.io demo torrents
const KNOWN={
  'dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c':{
    name:'Big Buck Bunny',
    url:'https://webtorrent.io/torrents/big-buck-bunny.torrent',
    ws:'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
  },
  '08ada5a7a6183aae1e09d831df6748d566095a10':{
    name:'Sintel',
    url:'https://webtorrent.io/torrents/sintel.torrent',
    ws:'https://archive.org/download/Sintel/sintel-2048-surround.mp4',
  },
  'a88fda5954e89178c372716a6a78b8180ed4dad3':{
    name:'Tears of Steel',
    url:'https://webtorrent.io/torrents/tears-of-steel.torrent',
    ws:'https://archive.org/download/tears-of-steel/tears_of_steel_1080p.mp4',
  },
  '6a9759bffd5c0af65319979fb7832189f4f3c35d':{
    name:'Elephants Dream',
    url:'https://webtorrent.io/torrents/elephants-dream.torrent',
    ws:'https://archive.org/download/ElephantsDream/ed_1024_512kb.mp4',
  },
};

// ── STATE ─────────────────────────────────────────────────────────
const S={
  wt:null, torrent:null, video:null,
  results:[], hudTick:null,
  myRank:-1, myName:'',
  // Chat queue — prevents antiflood drops
  chatQueue:[], chatTimer:null, chatBurstCount:0, chatBurstReset:null,
};

// On-screen debug panel — no browser devtools needed on mobile
const dbLines=[];
function dbWrite(level,args){
  const ts=new Date().toTimeString().slice(0,8);
  const msg=args.map(function(a){
    if(a===null)return'null';
    if(a===undefined)return'undefined';
    try{return typeof a==='object'?JSON.stringify(a):String(a);}catch(e){return String(a);}
  }).join(' ');
  const line='['+ts+'] '+(level==='W'?'⚠ ':level==='E'?'✖ ':'')+msg;
  dbLines.push(line);
  if(dbLines.length>120)dbLines.shift();
  const el=document.getElementById('hs-dblog');
  if(el){el.textContent=dbLines.slice(-40).join('\n');el.scrollTop=el.scrollHeight;}
}
const log=function(){dbWrite('L',Array.from(arguments));console.log('[HS]',...arguments);};
const warn=function(){dbWrite('W',Array.from(arguments));console.warn('[HS]',...arguments);};
const errlog=function(){dbWrite('E',Array.from(arguments));console.error('[HS]',...arguments);};

function buildDebugPanel(){
  if(document.getElementById('hs-debug'))return;
  const style=document.createElement('style');
  style.textContent=
    '#hs-debug{position:fixed;bottom:0;left:0;right:0;z-index:99999;'+
    'background:rgba(0,0,0,0.93);border-top:2px solid #0f0;display:none;flex-direction:column}'+
    '#hs-dbtop{display:flex;align-items:center;padding:3px 8px;background:#0a0a0a;gap:8px}'+
    '#hs-dbtop span{color:#0f0;font:11px monospace;flex:1}'+
    '#hs-dbtop button{background:0;border:1px solid #333;color:#aaa;font:10px monospace;'+
    'padding:2px 7px;cursor:pointer}'+
    '#hs-dbtop button:hover{border-color:#0f0;color:#0f0}'+
    '#hs-dblog{color:#0f0;font:10px monospace;padding:6px 8px;'+
    'height:160px;overflow-y:auto;white-space:pre-wrap;word-break:break-all}'+
    '#hs-dbtoggle{position:fixed;bottom:4px;right:4px;z-index:100000;'+
    'background:#0a0a0a;border:1px solid #0f0;color:#0f0;font:11px monospace;'+
    'padding:4px 10px;cursor:pointer;border-radius:3px}';
  document.head.appendChild(style);

  const panel=document.createElement('div');
  panel.id='hs-debug';
  panel.innerHTML=
    '<div id="hs-dbtop">'+
    '<span>HiveStream Debug Console</span>'+
    '<button id="hs-dbcopy">Copy</button>'+
    '<button id="hs-dbclear">Clear</button>'+
    '<button id="hs-dbstatus">Status</button>'+
    '<button id="hs-dbclose">✕</button>'+
    '</div>'+
    '<pre id="hs-dblog"></pre>';
  document.body.appendChild(panel);

  const toggle=document.createElement('button');
  toggle.id='hs-dbtoggle';
  toggle.textContent='HS log';
  document.body.appendChild(toggle);

  toggle.onclick=function(){
    const p=document.getElementById('hs-debug');
    p.style.display=p.style.display==='flex'?'none':'flex';
  };
  document.getElementById('hs-dbclose').onclick=function(){
    document.getElementById('hs-debug').style.display='none';
  };
  document.getElementById('hs-dbcopy').onclick=function(){
    const txt=dbLines.join('\n');
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(txt).then(function(){
        const b=document.getElementById('hs-dbcopy');
        b.textContent='Copied!';setTimeout(function(){b.textContent='Copy';},1500);
      }).catch(function(){fallbackCopy(txt);});
    }else{fallbackCopy(txt);}
  };
  function fallbackCopy(txt){
    const ta=document.createElement('textarea');
    ta.value=txt;ta.style.position='fixed';ta.style.opacity='0';
    document.body.appendChild(ta);ta.select();
    try{document.execCommand('copy');
      const b=document.getElementById('hs-dbcopy');
      b.textContent='Copied!';setTimeout(function(){b.textContent='Copy';},1500);
    }catch(e){warn('copy failed:',e);}
    document.body.removeChild(ta);
  }
  document.getElementById('hs-dbclear').onclick=function(){
    dbLines.length=0;
    const el=document.getElementById('hs-dblog');
    if(el)el.textContent='';
  };
  document.getElementById('hs-dbstatus').onclick=function(){
    const v=document.getElementById('hs-video');
    const hud=document.getElementById('hs-hud');
    const sp=document.getElementById('hs-spinner');
    dbWrite('L',['--- STATUS DUMP ---']);
    dbWrite('L',['version: '+V]);
    dbWrite('L',['socket connected: '+(window.socket?socket.connected:'no socket')]);
    dbWrite('L',['myName: '+S.myName+' rank: '+S.myRank]);
    dbWrite('L',['WebTorrent: '+(typeof WebTorrent)]);
    dbWrite('L',['wt client: '+(S.wt?'exists':'null')]);
    dbWrite('L',['torrent: '+(S.torrent?S.torrent.name+' peers='+S.torrent.numPeers:'null')]);
    dbWrite('L',['video readyState: '+(v?v.readyState:'no element')]);
    dbWrite('L',['video src: '+(v?v.src.slice(0,60):'—')]);
    dbWrite('L',['hud: '+(hud?hud.textContent.slice(0,80):'—')]);
    dbWrite('L',['spinner: '+(sp?sp.style.display:'—')]);
    dbWrite('L',['results count: '+S.results.length]);
  };
}

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
// CyTube enable_link_regex wraps URLs in chat as <a href="url">url</a> BEFORE
// the socket payload is sent. The anchor tag spans multiple space-split tokens so
// we must decode the ENTIRE relay body string first, then split into args.
//
// Converts: '!hs _t <a href="https://x.com/a.torrent">https://x.com/a.torrent</a> magnet:?xt=...'
// Into:     '!hs _t https://x.com/a.torrent magnet:?xt=...'
function decodeRelayBody(body){
  if(!body)return body;
  let s=body;
  // Step 1: replace <a href="URL">...</a> with just URL (CyTube link_regex wrapping)
  if(s.indexOf('<')>=0){
    s=s.replace(/<a[^>]+href="([^"]*)"[^>]*>[^<]*<\/a>/gi,function(_,href){
      return href; // keep raw, will decode entities below
    });
    // Strip any remaining tags
    s=s.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
  }
  // Step 2: decode HTML entities EVERYWHERE — CyTube encodes & as &amp; in full payload
  // This must happen AFTER tag removal so we don't double-decode href content
  s=s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"');
  return s;
}

// relayArg: rejoin parts (handles magnets that contain & which may have been re-split)
function relayArg(parts,start,end){
  return parts.slice(start,end===undefined?undefined:end).join(' ');
}

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
  buildDebugPanel();
  hookWindowErrors();
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
  // Deduplicate by URL
  if(S.pendingTorrentUrl === torrentUrl){
    log('dedup: same .torrent URL already pending, skipping');
    return;
  }
  S.pendingTorrentUrl = torrentUrl;
  log('fetching .torrent:',torrentUrl);
  fetch(torrentUrl)
    .then(function(r){
      if(!r.ok)throw new Error('HTTP '+r.status);
      const ct=(r.headers.get('content-type')||'').toLowerCase();
      log('.torrent content-type:',ct);
      // Reject HTML responses — server returned a webpage not a torrent file
      if(ct.indexOf('html')>=0)throw new Error('server returned HTML not .torrent');
      return r.arrayBuffer();
    })
    .then(function(buf){
      setSpinner(false);
      log('.torrent OK:',buf.byteLength,'bytes');
      // Sanity check: valid .torrent files start with 'd' (0x64) — bencoded dict
      const firstByte=new Uint8Array(buf)[0];
      if(firstByte!==0x64){
        throw new Error('not a torrent file (first byte=0x'+firstByte.toString(16)+')');
      }
      destroyCurrent(function(){
        const t=S.wt.add(new Uint8Array(buf));
        S.torrent=t; bind(t);
      });
    })
    .catch(function(e){
      setSpinner(false);
      warn('.torrent fetch failed ('+e.message+') — fallback:',fallback);
      chat('⚠ .torrent failed ('+e.message+') — trying magnet fallback');
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
  const cleanMagnet = cleanPeerTubeMagnet(magnet);
  log('startMagnet clean:', cleanMagnet.slice(0,120));
  // Deduplicate: if same torrent already running or pending, skip
  // Multiple clients each receive every relay message → each would call startMagnet
  // but destroyCurrent racing kills the torrent before ready fires
  const hashMatch = cleanMagnet.match(/btih:([0-9a-f]{40})/i);
  const newHash = hashMatch ? hashMatch[1].toLowerCase() : null;
  if(newHash && S.torrent && S.torrent.infoHash === newHash){
    log('dedup: same torrent already active, skipping');
    return;
  }
  if(newHash && S.pendingHash === newHash){
    log('dedup: same torrent already pending, skipping');
    return;
  }
  S.pendingHash = newHash;
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
    // Rebuild clean magnet:
    //   KEEP: xt (hash), dn (name), ws (webseed — critical for zero-peer playback)
    //   ADD:  our WSS trackers
    //   DROP: xs (torrent URL fetch — causes CORS), tr=http(s):// (HTTP trackers unusable in browser)
    let out = 'magnet:?xt=urn:btih:'+hash;
    if(params.dn&&params.dn[0])
      out += '&dn='+encodeURIComponent(params.dn[0]);
    // Preserve webseed URLs — these allow HTTP download with zero peers
    if(params.ws){
      params.ws.forEach(function(w){out+='&ws='+encodeURIComponent(w);});
    }
    // Add our WSS trackers (browser-compatible only)
    CFG.wss.forEach(function(t){out+='&tr='+encodeURIComponent(t);});
    return out;
  }catch(e){
    warn('cleanPeerTubeMagnet error:',e);
    return magnet;
  }
}

function mkClient(){
  const wt=new window.WebTorrent();
  wt.on('error',function(e){errlog('WT error:',e.message||e);});
  return wt;
}

function bind(torrent){
  torrent.on('infoHash',function(){
    log('infoHash:',torrent.infoHash);
    S.pendingHash=null; S.pendingTorrentUrl=null; // allow new requests after bind
  });
  torrent.on('metadata',function(){
    setSpinner(false);
    log('metadata:',torrent.name);
    chat('"'+torrent.name+'" ready — joining swarm');
    showHUD(true);
  });
  torrent.on('ready',function(){onReady(torrent);});
  torrent.on('warning',function(w){warn(w);});
  torrent.on('error',function(e){errlog('torrent:',e.message||e);setSpinner(false);});
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
function hookWindowErrors(){
  window.addEventListener('error',function(e){
    dbWrite('E',['UNCAUGHT: '+e.message+' @ '+e.filename+':'+e.lineno]);
  });
  window.addEventListener('unhandledrejection',function(e){
    dbWrite('E',['UNHANDLED PROMISE: '+(e.reason&&e.reason.message?e.reason.message:String(e.reason))]);
  });
}
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
  // Decode CyTube HTML link wrapping on the entire relay body before tokenising
  const decoded=decodeRelayBody(rest);
  if(decoded!==rest)log('decoded relay: '+decoded.slice(0,120));
  const parts=decoded.split(/\s+/);
  const cmd=parts[0]||'';
  const args=parts.slice(1);

  // Internal relay — all clients always process these
  // args may contain CyTube-HTML-encoded URLs (enable_link_regex wraps URLs in <a href>)
  if(cmd==='_t'){
    const tUrl=args[0]||'';
    const fallback=relayArg(args,1);
    log('relay _t url='+tUrl.slice(0,60));
    startTorrentUrl(tUrl,fallback);
    return;
  }
  if(cmd==='_m'){
    const mag=relayArg(args,0);
    log('relay _m mag='+mag.slice(0,80));
    startMagnet(mag);
    return;
  }
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
  if(k){
    chat('Loading: '+k.name);
    // _t relay: fetch .torrent file first (gives metadata + file structure instantly,
    // which unlocks the ws= webseed for zero-peer HTTP download).
    // Fallback magnet includes ws= so even if .torrent fails, webseed is available.
    let mag='magnet:?xt=urn:btih:'+hash+'&dn='+encodeURIComponent(k.name);
    if(k.ws)mag+='&ws='+encodeURIComponent(k.ws);
    CFG.wss.forEach(function(t){mag+='&tr='+encodeURIComponent(t);});
    relay('_t '+k.url+' '+mag);
  }else{
    relay('_m magnet:?xt=urn:btih:'+hash+
      CFG.wss.map(function(t){return'&tr='+encodeURIComponent(t);}).join(''));
  }
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
