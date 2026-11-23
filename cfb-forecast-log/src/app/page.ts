/** The local app's single page: vanilla HTML/CSS/JS, served by src/app/server.ts. */
export const APP_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Forecast Desk</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%231f6feb'/%3E%3Cellipse cx='16' cy='16' rx='11' ry='6.5' transform='rotate(-35 16 16)' fill='%23fff'/%3E%3Cpath d='M12.6 18.4l6.8-4.8M13.6 16.2l1.4 2M15.3 15l1.4 2M17 13.8l1.4 2' stroke='%231f6feb' stroke-width='1.3' stroke-linecap='round'/%3E%3C/svg%3E">
<style>
:root{--bg:#f5f6f8;--card:#fff;--ink:#16202c;--muted:#5d6b7c;--line:#dde3ea;--accent:#1f6feb;--ok:#1a7f45;--warn-bg:#fff4dc;--warn-ink:#7a4b00;--bad:#c62828;--soft:#eef2f7}
@media (prefers-color-scheme:dark){:root{--bg:#0e131a;--card:#161d27;--ink:#e6ecf2;--muted:#94a3b5;--line:#273242;--accent:#5b9dff;--ok:#43c47a;--warn-bg:#3a2c0e;--warn-ink:#f3cf86;--bad:#ff6b6b;--soft:#1d2633}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
header{position:sticky;top:0;z-index:2;background:var(--bg);border-bottom:1px solid var(--line)}
.bar{max-width:1080px;margin:0 auto;padding:12px 16px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.brand{font-weight:700;font-size:16px;margin-right:auto}
nav button{font:inherit;font-size:14px;background:none;border:0;color:var(--muted);padding:6px 10px;border-radius:8px;cursor:pointer}
nav button.on{background:var(--soft);color:var(--ink);font-weight:600}
main{max-width:1080px;margin:0 auto;padding:20px 16px 60px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-bottom:16px}
h2{font-size:17px;margin:0 0 10px}.small{font-size:13px;color:var(--muted)}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
select,input[type=text]{font:inherit;font-size:14px;padding:5px 8px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink)}
label{font-size:14px;display:flex;align-items:center;gap:6px}
.btn{font:inherit;font-size:14px;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:8px;padding:7px 12px;cursor:pointer}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}.btn:disabled{opacity:.5;cursor:default}
.grid{display:grid;grid-template-columns:minmax(240px,320px) 1fr;gap:16px;align-items:start}
.grid>*{min-width:0}
@media (max-width:760px){.grid{grid-template-columns:1fr}}
.games{max-height:70vh;overflow:auto;padding:6px}
.game{display:block;width:100%;text-align:left;font:inherit;background:none;border:0;border-radius:8px;padding:8px 10px;cursor:pointer;color:var(--ink)}
.game:hover{background:var(--soft)}.game.on{background:var(--soft);outline:2px solid var(--accent)}
.game .t{font-weight:600}.game .s{font-size:12px;color:var(--muted)}
.pill{display:inline-block;font-size:11px;font-weight:600;border-radius:999px;padding:1px 7px;margin-left:6px;background:var(--soft);color:var(--muted)}
.pill.sec{background:#1f6feb22;color:var(--accent)}.pill.off{background:var(--ok);color:#fff}.pill.bad{background:var(--bad);color:#fff}.pill.warn{background:var(--warn-bg);color:var(--warn-ink)}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:6px 6px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:500;white-space:nowrap}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
td.main,th.main{font-weight:650}
.team{font-size:14px;font-weight:650;margin:14px 0 4px}
details.tgroup{border-bottom:1px solid var(--line)}details.tgroup>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:8px;padding:10px 2px;font-size:14px;font-weight:650}
details.tgroup>summary::-webkit-details-marker{display:none}details.tgroup>summary::before{content:'';width:6px;height:6px;border-right:2px solid var(--muted);border-bottom:2px solid var(--muted);transform:rotate(-45deg);transition:transform .15s;flex:none}
details.tgroup[open]>summary::before{transform:rotate(45deg)}details.tgroup>summary .small{font-weight:400}details.tgroup>.scroll{margin-bottom:10px}
.linkbtn{font:inherit;font-size:13px;background:none;border:0;color:var(--muted);cursor:pointer;padding:4px 6px;text-decoration:underline}
pre{background:var(--soft);border-radius:8px;padding:10px;font-size:12px;max-height:340px;overflow:auto;white-space:pre-wrap;margin:10px 0 0}
.empty{color:var(--muted);font-size:14px;padding:8px 2px}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;background:var(--line)}.dot.ok{background:var(--ok)}.dot.bad{background:var(--bad)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:16px}
.n.other{border-left:1px solid var(--line);padding-left:12px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}.tile .v{font-size:20px;font-weight:650}
iframe{display:block;width:100%;height:80vh;border:0;background:transparent}
</style></head>
<body>
<header><div class="bar"><div class="brand">Forecast Desk</div>
<nav><button data-tab="board" class="on">Board</button><button data-tab="games">Games</button><button data-tab="news">News</button><button data-tab="picks">Picks</button><button data-tab="health">Health &amp; actions</button></nav></div></header>
<main>
<section id="tab-board"><iframe id="tracker" src="/tracker" title="Tracker page" scrolling="no"></iframe></section>

<section id="tab-games" hidden>
  <div class="grid">
    <div class="card"><h2 id="wk">Games</h2>
      <div class="row"><label><input type="checkbox" id="gsec"> SEC only</label><input type="text" id="gq" placeholder="Search team" style="flex:1;min-width:120px"></div>
      <div class="games" id="glist"></div></div>
    <div class="card" id="gdetail"><div class="empty">Pick a game.</div></div>
  </div>
</section>

<section id="tab-news" hidden>
  <div class="card"><h2>Injury and availability news</h2>
    <div class="row"><select id="ndays"><option value="2">Last 2 days</option><option value="4" selected>Last 4 days</option><option value="7">Last 7 days</option></select>
      <label><input type="checkbox" id="nsec" checked> SEC only</label><input type="text" id="nq" placeholder="Filter team" style="flex:1;min-width:120px"></div>
    <div class="row" style="justify-content:space-between"><div class="small">Recaps of games already played are hidden. <span class="pill off">Official</span> = conference availability report.</div><div><button class="linkbtn" id="nopen">Expand all</button><button class="linkbtn" id="nclose">Collapse all</button></div></div>
    <div id="nlist"></div></div>
</section>

<section id="tab-picks" hidden>
  <div class="card"><h2>Picks scorecard</h2>
    <div class="small">What shows and articles picked, graded after the games. Break-even against the spread is 52.4%. A record over a few dozen picks is noise. No model reads this.</div>
    <div class="row" style="margin-top:10px"><label><input type="checkbox" id="pmin" checked> Only sources with 10+ graded picks</label></div>
    <div id="pboard"></div>
    <h2 style="margin-top:18px">Recent picks</h2>
    <div class="row"><select id="pdays"><option value="3">Last 3 days</option><option value="7" selected>Last 7 days</option><option value="14">Last 14 days</option><option value="30">Last 30 days</option></select><input type="text" id="pq" placeholder="Filter team or source" style="flex:1;min-width:120px"></div>
    <div id="plist"></div></div>
</section>

<section id="tab-health" hidden>
  <div class="tiles" id="tiles"></div>
  <div class="card"><h2>Actions</h2><div class="small">The same commands you would run in Terminal. One at a time.</div>
    <div class="row" id="actions" style="margin-top:10px"></div><pre id="out" hidden></pre></div>
  <div class="card"><h2>Scheduled jobs</h2><div class="scroll"><table id="jobs"></table></div></div>
</section>
</main>
<script>
var TZ='America/Chicago';
function t(iso,opt){return iso?new Date(iso).toLocaleString('en-US',Object.assign({timeZone:TZ},opt||{weekday:'short',hour:'numeric',minute:'2-digit'})):'—'}
function ago(iso){if(!iso)return 'never';var m=Math.round((Date.now()-Date.parse(iso))/60000);if(m<60)return m+' min ago';var h=Math.round(m/60);if(h<48)return h+' h ago';return Math.round(h/24)+' days ago'}
function pct(x){return x==null?'—':Math.round(x*100)+'%'}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function get(u){return fetch(u).then(function(r){return r.json()})}

// tabs
var tabs=document.querySelectorAll('nav button');
function show(name){tabs.forEach(function(b){b.classList.toggle('on',b.dataset.tab===name)});
['board','games','news','picks','health'].forEach(function(n){document.getElementById('tab-'+n).hidden=n!==name});
try{localStorage.setItem('desk-tab',name)}catch(e){}
if(name==='games')loadGames();if(name==='news')loadNews();if(name==='picks')loadPicks();if(name==='health')loadHealth();}
tabs.forEach(function(b){b.addEventListener('click',function(){show(b.dataset.tab)})});

// games
var games=[],sel=null,flip=false,asLine=false;
function loadGames(){get('/api/games').then(function(d){games=d.games||[];document.getElementById('wk').textContent=d.week?'Week '+d.week+' games':'Games';renderList()})}
function renderList(){var sec=document.getElementById('gsec').checked,q=document.getElementById('gq').value.toLowerCase();
var html=games.filter(function(g){return(!sec||g.sec)&&(!q||(g.home+' '+g.away).toLowerCase().indexOf(q)>=0)}).map(function(g){
var score=g.completed&&g.home_points!=null?' · Final '+g.away_points+'–'+g.home_points:'';
return '<button class="game'+(sel===g.game_id?' on':'')+'" data-id="'+g.game_id+'"><div class="t">'+esc(g.away)+' at '+esc(g.home)+(g.sec?'<span class="pill sec">SEC</span>':'')+'</div><div class="s">'+t(g.kickoff_utc)+score+'</div></button>'}).join('');
var el=document.getElementById('glist');el.innerHTML=html||'<div class="empty">No games match.</div>';
el.querySelectorAll('.game').forEach(function(b){b.addEventListener('click',function(){sel=Number(b.dataset.id);flip=false;renderList();loadGame()})})}
document.getElementById('gsec').addEventListener('change',renderList);document.getElementById('gq').addEventListener('input',renderList);
var ORDER=['v5.3-fused','v3-anchor','v1-blend','v5.2-fused','v5.1-fused','v5-fused','v4.1-avail','v4-avail','v2-qb'],READ=['v3-anchor','v1-blend'],MAIN={};
function loadGame(){get('/api/game?id='+sel).then(renderGame)}
function ncdf(x){var t=1/(1+0.3275911*Math.abs(x)/Math.SQRT2),y=1-((((1.061405429*t-1.453152027)*t+1.421413741)*t-0.284496736)*t+0.254829592)*t*Math.exp(-x*x/2);return x<0?(1-y)/2:(1+y)/2}
function nq(p){p=Math.min(0.999,Math.max(0.001,p));var lo=-6,hi=6;for(var i=0;i<60;i++){var m=(lo+hi)/2;if(ncdf(m)<p)lo=m;else hi=m}return (lo+hi)/2}
function fl(x){if(x==null)return '—';x=Math.round(x*2)/2;return x===0?'PK':(x>0?'+':'−')+Math.abs(x)}
function line(p){return p==null?null:-13.5*nq(p)}
function renderGame(d){var g=d.game,side=flip?g.away:g.home,f=function(p){return p==null?null:(flip?1-p:p)};var cell=function(p){return asLine?fl(line(f(p))):pct(f(p))},vline=function(s){return s.vegas_spread!=null?fl(flip?-s.vegas_spread:s.vegas_spread):cell(s.vegas)};
var models=ORDER.filter(function(m){return d.snapshots.some(function(s){return s.model_version===m})});
d.snapshots.forEach(function(s){if(models.indexOf(s.model_version)<0)models.push(s.model_version)});
// Main model: v5.3, or v5.1 for games logged before v5.3 existed. Main first, then the two read models, then the rest.
var mainM=models.indexOf('v5.3-fused')>=0?'v5.3-fused':'v5.1-fused';MAIN={};MAIN[mainM]=1;
var lead=[mainM].concat(READ).filter(function(m){return models.indexOf(m)>=0});
models=lead.concat(models.filter(function(m){return lead.indexOf(m)<0}));var firstOther=models[lead.length];
var snaps={};d.snapshots.forEach(function(s){var k=s.snapshot_kind+'|'+s.snapshot_utc;(snaps[k]=snaps[k]||{kind:s.snapshot_kind,at:s.snapshot_utc,m:{},kalshi:s.kalshi,vegas:s.vegas,vegas_spread:s.vegas_spread}).m[s.model_version]=s.home_prob});
(d.spreads||[]).forEach(function(s){var k=s.snapshot_kind+'|'+s.snapshot_utc;(snaps[k]=snaps[k]||{kind:s.snapshot_kind,at:s.snapshot_utc,m:{},kalshi:null,vegas:null,vegas_spread:null}).m1=s.home_margin});
var hasM1=(d.spreads||[]).length>0,m1cell=function(s){if(s.m1==null)return '—';var x=flip?s.m1:-s.m1;return asLine?fl(x):pct(ncdf(-x/13.5))};
var keys=Object.keys(snaps).sort(function(a,b){return snaps[a].at<snaps[b].at?-1:1});
var head='<tr><th>Snapshot</th>'+models.map(function(m){return '<th class="n'+(MAIN[m]?' main':'')+(m===firstOther?' other':'')+'"'+(m===firstOther?' title="Logged, not read"':'')+'>'+esc(m.replace('-fused','').replace('-anchor','').replace('-blend','').replace('-avail','').replace('-qb',''))+'</th>'}).join('')+(hasM1?'<th class="n main" title="m1-margin: spread model trained on final scores">m1</th>':'')+'<th class="n">Kalshi</th><th class="n">Vegas</th></tr>';
var body=keys.map(function(k){var s=snaps[k];return '<tr><td>'+esc(s.kind)+'<div class="small">'+t(s.at)+'</div></td>'+models.map(function(m){return '<td class="n'+(m===firstOther?' other':'')+(MAIN[m]?' main':'')+'">'+cell(s.m[m])+'</td>'}).join('')+(hasM1?'<td class="n main">'+m1cell(s)+'</td>':'')+'<td class="n">'+cell(s.kalshi)+'</td><td class="n">'+(asLine?vline(s):pct(f(s.vegas)))+'</td></tr>'}).join('');
var result=g.completed&&g.home_points!=null?'<span class="pill">Final: '+esc(g.away)+' '+g.away_points+', '+esc(g.home)+' '+g.home_points+'</span>':'';
var facts=[g.away,g.home].map(function(team){var fs=d.facts.filter(function(x){return x.team===team});
return '<div class="team">'+esc(team)+'</div>'+(fs.length?'<div class="scroll"><table>'+fs.slice(0,25).map(factRow).join('')+'</table></div>':'<div class="empty">No availability news in the 10 days before kickoff.</div>')}).join('');
document.getElementById('gdetail').innerHTML='<h2>'+esc(g.away)+' at '+esc(g.home)+(g.sec?'<span class="pill sec">SEC</span>':'')+'</h2><div class="small">'+t(g.kickoff_utc,{weekday:'long',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})+' '+result+'</div>'+
'<div class="row" style="margin:12px 0 6px"><span class="small">'+(asLine?'Point spread for <b>'+esc(side)+'</b> (negative = favored) at each snapshot. Model and Kalshi columns are their win chances turned into points (sd 13.5); Vegas is the posted spread.':'Chance that <b>'+esc(side)+'</b> wins, at each snapshot.')+' Main model is '+esc(mainM.replace('-fused',''))+'; the columns after v1 are logged but not read.</span><span><button class="btn" id="asline">'+(asLine?'Show win %':'Show spreads')+'</button> <button class="btn" id="flip">Show '+esc(flip?g.home:g.away)+'</button></span></div>'+
(keys.length?'<div class="scroll"><table>'+head+body+'</table></div>':'<div class="empty">No forecasts logged for this game yet.</div>')+'<h2 style="margin-top:18px">Availability news</h2>'+facts;
document.getElementById('flip').addEventListener('click',function(){flip=!flip;renderGame(d)});document.getElementById('asline').addEventListener('click',function(){asLine=!asLine;renderGame(d)})}
function factRow(x){var st=x.status==='out'?'bad':(x.status==='doubtful'||x.status==='questionable'||x.status==='limited')?'warn':'';
return '<tr><td style="white-space:nowrap">'+esc(x.player||'(group)')+'<div class="small">'+esc(x.position||'')+'</div></td><td><span class="pill '+st+'">'+esc(x.status)+'</span>'+(x.official?'<span class="pill off">Official</span>':'')+'</td><td>'+esc(x.detail||'')+'<div class="small">'+esc(x.source||'')+' · '+t(x.as_of)+'</div></td></tr>'}

// news
function loadNews(){var days=document.getElementById('ndays').value,sec=document.getElementById('nsec').checked?'1':'0';
get('/api/news?days='+days+'&sec='+sec).then(function(rows){window._news=rows;renderNews()})}
function renderNews(){var q=document.getElementById('nq').value.toLowerCase(),rows=(window._news||[]).filter(function(x){return!q||x.team.toLowerCase().indexOf(q)>=0});
var by={};rows.forEach(function(x){(by[x.team]=by[x.team]||[]).push(x)});
var teams=Object.keys(by).sort();
var auto=q&&teams.length<=3;
document.getElementById('nlist').innerHTML=teams.length?teams.map(function(team){var f=by[team],o=f.filter(function(x){return x.status==='out'||x.status==='doubtful'}).length,off=f.some(function(x){return x.official});
return '<details class="tgroup" data-team="'+esc(team)+'"'+(auto||openTeams[team]?' open':'')+'><summary>'+esc(team)+' <span class="small">'+f.length+' item'+(f.length===1?'':'s')+(o?' · '+o+' out or doubtful':'')+'</span>'+(off?'<span class="pill off">Official</span>':'')+'</summary><div class="scroll"><table>'+f.slice(0,30).map(factRow).join('')+'</table></div></details>'}).join(''):'<div class="empty">No news in this window.</div>';
document.querySelectorAll('#nlist details').forEach(function(d){d.addEventListener('toggle',function(){if(d.open)openTeams[d.dataset.team]=1;else delete openTeams[d.dataset.team];saveOpen()})})}
var openTeams={};try{openTeams=JSON.parse(localStorage.getItem('desk-news-open')||'{}')||{}}catch(e){}
function saveOpen(){try{localStorage.setItem('desk-news-open',JSON.stringify(openTeams))}catch(e){}}
function setAll(open){document.querySelectorAll('#nlist details').forEach(function(d){d.open=open})}
document.getElementById('nopen').addEventListener('click',function(){setAll(true)});document.getElementById('nclose').addEventListener('click',function(){setAll(false)});
document.getElementById('ndays').addEventListener('change',loadNews);document.getElementById('nsec').addEventListener('change',loadNews);document.getElementById('nq').addEventListener('input',renderNews);

// picks
function rec3(r){var n=r.w+r.l+r.p;return n?r.w+'-'+r.l+(r.p?'-'+r.p:''):'—'}
function rate(r){return r.w+r.l?Math.round(100*r.w/(r.w+r.l))+'%':''}
function loadPicks(){get('/api/picks?days='+document.getElementById('pdays').value).then(function(d){window._picks=d;renderPicks()})}
function renderPicks(){var d=window._picks;if(!d)return;var min=document.getElementById('pmin').checked?10:1;
var head='<tr><th>Source</th><th>Graded</th><th>Against the spread</th><th>Straight up</th><th>Underdogs (won)</th><th>Totals</th><th>Leans</th><th>Set aside</th></tr>';
function line(r,bold){return '<tr><td>'+(bold?'<b>'+esc(r.source)+'</b>':esc(r.source))+'</td><td>'+r.graded+'</td><td>'+rec3(r.ats)+' <span class="small">'+rate(r.ats)+'</span></td><td>'+rec3(r.su)+' <span class="small">'+rate(r.su)+'</span></td><td>'+(r.dogs.n?r.dogs.n+' ('+r.dogs.w+')':'—')+'</td><td>'+rec3(r.total)+'</td><td>'+rec3(r.lean)+'</td><td class="small">'+(r.conflicted+r.unmatched)+'</td></tr>'}
var rows=(d.total?line(d.total,true):'')+d.collections.map(function(r){return line(r,true)}).join('')+d.channels.filter(function(r){return r.graded>=min}).map(function(r){return line(r,false)}).join('');
document.getElementById('pboard').innerHTML=d.total?'<div class="scroll"><table>'+head+rows+'</table></div>':'<div class="empty">No picks stored yet.</div>';
var q=document.getElementById('pq').value.toLowerCase();
var recent=d.recent.filter(function(x){return!q||[x.team,x.opponent,x.source,x.host].join(' ').toLowerCase().indexOf(q)>=0});
document.getElementById('plist').innerHTML=recent.length?'<div class="scroll"><table>'+recent.slice(0,150).map(function(x){
var g=x.conflicted?'<span class="pill">both sides</span>':x.grade==='win'?'<span class="pill off">won</span>':x.grade==='loss'?'<span class="pill bad">lost</span>':x.grade==='push'?'<span class="pill">push</span>':'<span class="pill warn">'+esc(x.ungraded||'pending')+'</span>';
return '<tr><td style="white-space:nowrap">'+esc(x.team||'?')+' <span class="small">vs '+esc(x.opponent||'?')+'</span><div class="small">'+esc(x.kind.replace(/_/g,' '))+(x.line==null?'':' '+(x.kind==='spread'&&x.line>0?'+':'')+x.line)+'</div></td><td>'+g+'</td><td>'+esc(x.quote||'')+'<div class="small">'+esc(x.source||'')+(x.host?' · '+esc(x.host):'')+' · '+t(x.as_of)+'</div></td></tr>'}).join('')+'</table></div>':'<div class="empty">No picks in this window.</div>'}
document.getElementById('pdays').addEventListener('change',loadPicks);document.getElementById('pmin').addEventListener('change',renderPicks);document.getElementById('pq').addEventListener('input',renderPicks);

// health and actions
var poll=null;
function loadHealth(){get('/api/health').then(function(h){
var tiles=[['Keep-awake (caffeinate)',h.caffeinate?'<span class="dot ok"></span>Running':'<span class="dot bad"></span>Not running',h.caffeinate?'':'Run caffeinate -is in Terminal'],
['Scheduled jobs (cron)',h.cronLines?'<span class="dot ok"></span>'+h.cronLines+' installed':'<span class="dot bad"></span>None found',''],
['Last snapshot',ago(h.lastSnapshot),t(h.lastSnapshot)],['Forecasts logged',h.rows.forecasts.toLocaleString(),h.rows.graded.toLocaleString()+' graded'],['News facts',h.rows.facts.toLocaleString(),'']];
document.getElementById('tiles').innerHTML=tiles.map(function(x){return '<div class="tile"><div class="small">'+x[0]+'</div><div class="v">'+x[1]+'</div><div class="small">'+esc(x[2])+'</div></div>'}).join('');
document.getElementById('jobs').innerHTML='<tr><th>Job</th><th>Last success</th><th>Last failure</th></tr>'+h.jobs.map(function(j){var bad=j.lastFailed&&(!j.lastDone||j.lastFailed>j.lastDone);
return '<tr><td><span class="dot '+(bad?'bad':j.lastDone?'ok':'')+'"></span>'+esc(j.job)+'</td><td>'+(j.lastDone?ago(j.lastDone)+'<div class="small">'+t(j.lastDone)+'</div>':'—')+'</td><td>'+(j.lastFailed?ago(j.lastFailed)+'<div class="small">'+t(j.lastFailed)+'</div>':'—')+'</td></tr>'}).join('');
var a=document.getElementById('actions');a.innerHTML=Object.keys(h.actions).map(function(k,i){return '<button class="btn'+(i===0?' primary':'')+'" data-a="'+k+'">'+esc(h.actions[k])+'</button>'}).join('');
a.querySelectorAll('button').forEach(function(b){b.addEventListener('click',function(){start(b.dataset.a)})});
showRun(h.running)})}
function start(name){fetch('/api/run/'+name,{method:'POST'}).then(function(r){return r.json()}).then(function(r){if(r.error){alert(r.error);return}showRun(r)})}
function showRun(r){var out=document.getElementById('out'),btns=document.querySelectorAll('#actions button');
if(!r){out.hidden=true;return}out.hidden=false;out.textContent=r.output+(r.done?(r.ok?'\\n✓ Done':'\\n✗ Failed'):'\\n… running');out.scrollTop=out.scrollHeight;
btns.forEach(function(b){b.disabled=!r.done});
if(!r.done){clearTimeout(poll);poll=setTimeout(function(){get('/api/run').then(showRun)},1000)}
else{clearTimeout(poll);document.getElementById('tracker').src='/tracker'}}

// The tracker is embedded at its full height so the page scrolls once (no frame inside the page).
function fitTracker(){var f=document.getElementById('tracker');try{var d=f.contentDocument;if(!d||!d.documentElement)return;var h=d.documentElement.scrollHeight;if(h>0)f.style.height=h+'px'}catch(e){}}
(function(){var f=document.getElementById('tracker');f.addEventListener('load',function(){fitTracker();try{var d=f.contentDocument;d.documentElement.style.overflow='hidden';if(window.ResizeObserver)new ResizeObserver(fitTracker).observe(d.body);d.addEventListener('click',function(){setTimeout(fitTracker,0)})}catch(e){}});})();
document.querySelectorAll('[data-tab]').forEach(function(b){b.addEventListener('click',function(){setTimeout(fitTracker,0)})});
var start0='board';try{start0=localStorage.getItem('desk-tab')||'board'}catch(e){}show(start0);
</script>
</body></html>
`;
