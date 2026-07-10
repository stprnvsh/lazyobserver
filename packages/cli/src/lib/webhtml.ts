/** The dashboard page — self-contained, zero external assets, localhost only. */
export const DASHBOARD_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>lazyobserver</title>
<style>
:root{
  --bg:#0a0d12;--surface:#10151d;--surface2:#141b26;--line:#1d2634;
  --text:#e2e8f0;--dim:#8294a7;--faint:#5b6b7e;
  --acc:#2dd4a7;--acc-dim:rgba(45,212,167,.12);
  --blue:#6aa6e8;--blue-dim:rgba(106,166,232,.12);
  --amber:#f0b45c;--amber-dim:rgba(240,180,92,.12);
  --red:#e5726a;--red-dim:rgba(229,114,106,.12);
  --mono:ui-monospace,'SF Mono',Menlo,monospace;
}
*{box-sizing:border-box}
html{color-scheme:dark}
body{margin:0;font:13.5px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--text);-webkit-font-smoothing:antialiased}
::selection{background:var(--acc-dim)}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-thumb{background:var(--line);border-radius:5px;border:2px solid var(--bg)}
::-webkit-scrollbar-track{background:transparent}

header{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:20px;
  padding:0 24px;height:56px;background:rgba(10,13,18,.82);backdrop-filter:blur(12px);
  border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:9px;font-size:14px;font-weight:650;letter-spacing:-.2px}
.brand .dot{width:9px;height:9px;border-radius:50%;background:var(--acc);box-shadow:0 0 10px var(--acc)}
.brand em{font-style:normal;color:var(--acc)}
nav{display:flex;gap:2px;background:var(--surface);border:1px solid var(--line);border-radius:9px;padding:3px}
nav button{background:none;border:none;color:var(--dim);padding:5px 14px;border-radius:6px;cursor:pointer;
  font:inherit;font-size:12.5px;font-weight:520;transition:color .15s,background .15s}
nav button:hover{color:var(--text)}
nav button.on{background:var(--surface2);color:var(--text);box-shadow:inset 0 0 0 1px var(--line)}
nav button:focus-visible{outline:2px solid var(--acc);outline-offset:1px}
header input[type=date]{background:var(--surface);border:1px solid var(--line);color:var(--text);
  border-radius:8px;padding:5px 10px;font:inherit;font-size:12.5px;color-scheme:dark}
header input[type=date]:focus{outline:none;border-color:var(--acc)}
.spacer{flex:1}
.exports{display:flex;gap:6px;align-items:center}
.exports span{color:var(--faint);font-size:11px;text-transform:uppercase;letter-spacing:.6px;margin-right:2px}
.exports a{color:var(--dim);text-decoration:none;font-size:12px;font-family:var(--mono);
  border:1px solid var(--line);border-radius:6px;padding:3px 9px;transition:all .15s}
.exports a:hover{color:var(--acc);border-color:var(--acc);text-decoration:none}

main{max-width:1120px;margin:0 auto;padding:28px 24px 80px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:22px}
.card{background:linear-gradient(180deg,var(--surface2),var(--surface));border:1px solid var(--line);
  border-radius:12px;padding:16px 18px;transition:transform .15s,border-color .15s}
.card:hover{transform:translateY(-1px);border-color:#2a3648}
.card b{display:block;font-size:24px;font-weight:640;letter-spacing:-.5px;font-variant-numeric:tabular-nums;margin-bottom:2px}
.card span{color:var(--dim);font-size:10.5px;text-transform:uppercase;letter-spacing:.7px;font-weight:540}
.card .sub{color:var(--faint);font-size:11px;margin-top:3px;text-transform:none;letter-spacing:0}

section{background:var(--surface);border:1px solid var(--line);border-radius:12px;margin-bottom:16px;overflow:hidden}
section>h2{display:flex;align-items:center;justify-content:space-between;font-size:11px;font-weight:600;
  text-transform:uppercase;color:var(--dim);letter-spacing:.8px;margin:0;padding:12px 18px;
  border-bottom:1px solid var(--line);background:rgba(255,255,255,.012)}
h2 .count{font-family:var(--mono);font-size:11px;color:var(--faint);background:var(--surface2);
  border:1px solid var(--line);border-radius:10px;padding:1px 9px;letter-spacing:0}
.body{padding:6px 18px 10px}
.row{display:flex;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.035);font-size:13px}
.row:last-child{border:0}
.grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dim{color:var(--dim)}.faint{color:var(--faint)}
.time{font-family:var(--mono);font-size:11px;color:var(--faint);width:42px;flex-shrink:0}
.tag{font-size:10px;font-weight:560;padding:2px 9px;border-radius:10px;border:1px solid var(--line);
  color:var(--dim);white-space:nowrap;letter-spacing:.3px}
.tag.acc{color:var(--acc);border-color:transparent;background:var(--acc-dim)}
.tag.blue{color:var(--blue);border-color:transparent;background:var(--blue-dim)}
.tag.amber{color:var(--amber);border-color:transparent;background:var(--amber-dim)}
.tag.red{color:var(--red);border-color:transparent;background:var(--red-dim)}
.tag.mono{font-family:var(--mono)}
.avatar{display:inline-flex;align-items:center;gap:6px;color:var(--dim);font-size:11.5px;flex-shrink:0}
.avatar i{font-style:normal;width:18px;height:18px;border-radius:50%;background:var(--surface2);
  border:1px solid var(--line);display:inline-flex;align-items:center;justify-content:center;
  font-size:9px;font-weight:650;color:var(--acc)}
a{color:var(--acc);text-decoration:none}
a:hover{text-decoration:underline;text-underline-offset:3px}
pre{white-space:pre-wrap;font:12px/1.6 var(--mono);color:var(--text);margin:0;max-width:78ch}
input.search{width:100%;background:var(--surface);border:1px solid var(--line);color:var(--text);
  border-radius:10px;padding:11px 14px;margin-bottom:14px;font:inherit;transition:border-color .15s,box-shadow .15s}
input.search:focus{outline:none;border-color:var(--acc);box-shadow:0 0 0 3px var(--acc-dim)}
input.search::placeholder{color:var(--faint)}
.empty{color:var(--faint);padding:22px 0;font-size:13px}
.empty code{font-family:var(--mono);font-size:12px;color:var(--dim);background:var(--surface2);
  border:1px solid var(--line);border-radius:6px;padding:2px 8px}
.loading{color:var(--faint);padding:40px;text-align:center;animation:pulse 1.2s ease-in-out infinite}
@keyframes pulse{50%{opacity:.45}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
</style></head><body>
<header>
  <div class="brand"><span class="dot"></span>lazy<em>observer</em></div>
  <nav>
    <button data-v="today" class="on">Today</button>
    <button data-v="tasks">Tasks</button>
    <button data-v="journal">Journal</button>
    <button data-v="search">Search</button>
  </nav>
  <input type="date" id="date">
  <div class="spacer"></div>
  <div class="exports" id="exports"></div>
</header>
<main id="main"><div class="loading">loading</div></main>
<script>
const $=s=>document.querySelector(s);const main=$('#main');const dateEl=$('#date');
dateEl.value=new Date().toLocaleDateString('en-CA');let view='today';
document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>{view=b.dataset.v;document.querySelectorAll('nav button').forEach(x=>x.classList.toggle('on',x===b));render()});
dateEl.onchange=render;
const esc=s=>String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;');
const t=ms=>new Date(+ms).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
const num=n=>Number(n||0).toLocaleString();
const pj=s=>{try{return JSON.parse(s||'{}')||{}}catch(e){return{}}}; // one bad payload must never kill a view
const initials=n=>String(n||'').split(/[\\s,]+/).filter(Boolean).slice(0,2).map(w=>w[0]).join('').toUpperCase();
const av=n=>n?\`<span class="avatar"><i>\${esc(initials(n))}</i>\${esc(String(n).split(',')[0])}\${String(n).includes(',')?' +':''}</span>\`:'';
const statusTag=s=>({in_progress:'acc',review:'amber',blocked:'red',done:''}[s]??'');
async function api(p){const r=await fetch(p);if(!r.ok)throw new Error(p+' -> '+r.status);return r.json()}
function exportLinks(){const d=dateEl.value;$('#exports').innerHTML=\`<span>export</span><a href="/export/\${d}.md">md</a><a href="/export/\${d}.html">html</a><a href="/export/\${d}.json">json</a>\`}
const sec=(title,count,inner)=>\`<section><h2>\${title}<span class="count">\${count}</span></h2><div class="body">\${inner}</div></section>\`;
const empty=(msg,cmd)=>\`<div class="empty">\${msg}\${cmd?\` — <code>\${cmd}</code>\`:''}</div>\`;
async function render(){try{await renderView()}catch(err){main.innerHTML=sec('error','!',\`<pre>\${esc(err.stack||err)}</pre>\`)}}
async function renderView(){exportLinks();main.innerHTML='<div class="loading">loading</div>';
 if(view==='today'){
  const [r,ev]=await Promise.all([api('/api/report?date='+dateEl.value),api('/api/events?date='+dateEl.value)]);
  const T=r.totals;
  const sprints=r.tasks.sprints.map(s=>\`<div class="row"><span class="grow">\${esc(s.name)}</span><span class="tag mono acc">\${s.done}/\${s.total} · \${s.percent}%</span></div>\`).join('');
  const worked=[...r.tasks.doneToday.map(x=>\`<div class="row"><span class="tag acc">done</span><span class="grow">\${esc(x.source_id)} \${esc(x.title)}</span>\${x.pr_url?\`<a href="\${esc(x.pr_url)}" target="_blank">PR</a>\`:''}</div>\`),
    ...r.tasks.workedOn.map(x=>\`<div class="row"><span class="tag \${statusTag(x.status)}">\${esc(x.status).replace('_',' ')}</span><span class="grow">\${esc(x.source_id)} \${esc(x.title)}</span><span class="tag mono">\${r.tasks.minutesByTask[x.id]?'~'+r.tasks.minutesByTask[x.id]+'m':''}</span></div>\`)].join('');
  main.innerHTML=\`
  <div class="cards">
   <div class="card"><b>\${T.sessions}</b><span>sessions</span><div class="sub">\${T.minutes} min tracked</div></div>
   <div class="card"><b>\${r.tasks.doneToday.length}</b><span>tasks done today</span><div class="sub">\${r.tasks.workedOn.length} worked on</div></div>
   <div class="card"><b>\${num(T.tokensIn+T.tokensOut)}</b><span>tokens</span><div class="sub">$\${T.costUsd.toFixed(2)} spent</div></div>
   <div class="card"><b>\${T.userPrompts} <span style="color:var(--faint);font-size:15px">→</span> \${T.agentActions}</b><span>user → agent</span><div class="sub">prompts → actions</div></div>
  </div>
  \${sec('Sessions',r.material.sessions.length,r.material.sessions.map(s=>\`<div class="row"><span class="tag \${s.surface==='vscode'?'blue':'acc'}">\${esc(s.surface||'?')}</span><span class="grow"><b>\${esc(s.repo.split('/').pop()||'—')}</b> <span class="dim">@ \${esc(s.branch||'—')}</span></span><span class="dim" style="font-variant-numeric:tabular-nums">\${s.minutes}m · \${num(s.tokens_in+s.tokens_out)} tok</span><span class="tag mono">\${esc((s.model||'').replace('claude-',''))}</span></div>\`).join('')||empty('no sessions captured for this day'))}
  \${worked?sec('Tasks touched',r.tasks.doneToday.length+r.tasks.workedOn.length,worked):''}
  \${sprints?sec('Sprint progress',r.tasks.sprints.length,sprints):''}
  \${sec('Decisions',r.decisions.length,r.decisions.map(d=>\`<div class="row"><span class="grow" style="white-space:normal"><b>\${esc(d.choice)}</b><br><span class="dim">\${esc(d.rationale)}</span></span><span class="tag">\${esc(d.proposed_by)} → \${esc(d.decided_by)}</span></div>\`).join('')||empty('no decisions recorded','lzo eod'))}
  \${sec('Event timeline',ev.length,ev.slice(-250).map(e=>{const p=pj(e.payload);const d=(p.tool_input||{}).file_path||(p.tool_input||{}).command||p.prompt||'';
    return \`<div class="row"><span class="time">\${t(e.ts)}</span><span class="tag \${e.actor==='user'?'acc':e.actor==='agent'?'blue':''}">\${esc(e.actor)}</span><span class="tag">\${esc(e.kind).replace('_',' ')}</span><span class="grow faint" style="font-family:var(--mono);font-size:11.5px">\${esc(String(d).slice(0,110))}</span>\${e.task_id?\`<span class="tag amber mono">\${esc(e.task_id.split(':').pop())}</span>\`:''}</div>\`}).join('')||empty('nothing captured yet — the daemon ingests as you work'))}\`;
 } else if(view==='tasks'){
  const tasks=await api('/api/tasks');
  main.innerHTML='<input class="search" id="tf" placeholder="Filter by assignee or title — try your name…"><div id="tlist"></div>';
  const draw=()=>{const q=($('#tf').value||'').toLowerCase();
   const filtered=q?tasks.filter(x=>String(x.assignee||'').toLowerCase().includes(q)||String(x.title||'').toLowerCase().includes(q)):tasks;
   const groups={in_progress:'In progress',review:'In review',blocked:'Blocked',todo:'To do',done:'Done'};
   $('#tlist').innerHTML=Object.entries(groups).map(([k,label])=>{const g=filtered.filter(x=>x.status===k);if(!g.length)return'';
    return sec(label,g.length,g.map(x=>{const d=pj(x.description);
     return \`<div class="row"><span class="tag \${statusTag(x.status)||''} mono">\${esc(x.source)}</span><span class="grow"><a href="\${esc(x.url)}" target="_blank">\${esc(x.source_id)}</a> \${esc(x.title)}</span>\${av(x.assignee)}<span class="faint" style="font-size:11px;flex-shrink:0">\${esc(x.sprint||'')}\${d.due?' · due '+esc(d.due):''}\${x.branch?' · '+esc(x.branch):''}</span></div>\`}).join(''))}).join('')||sec('Tasks',0,empty('no matching tasks','lzo tasks sync'))};
  $('#tf').oninput=draw;draw();
 } else if(view==='journal'){
  const rows=await api('/api/journal?date='+dateEl.value);
  const doc=rows.find(x=>x.kind==='day_doc');const notes=rows.filter(x=>x.kind==='entry');
  main.innerHTML=
   sec('Day document',doc?1:0,doc?\`<div style="padding:8px 0"><b style="font-size:15px">\${esc(doc.title)}</b><div style="height:10px"></div><pre>\${esc(doc.body)}</pre></div>\`:empty('no day document yet','lzo eod'))+
   sec('Notes',notes.length,notes.map(n=>\`<div class="row"><span class="grow" style="white-space:normal">\${n.title?\`<b>\${esc(n.title)}</b><br>\`:''}<span class="dim">\${esc(n.body)}</span></span></div>\`).join('')||empty('no journal notes — agents write them via journal_note'));
 } else if(view==='search'){
  main.innerHTML='<input class="search" id="q" placeholder="Search memory and conversations — semantic + exact identifiers… (Enter)"><div id="res"></div>';
  $('#q').focus();
  $('#q').onkeydown=async e=>{if(e.key!=='Enter')return;$('#res').innerHTML='<div class="loading">searching</div>';
   const r=await api('/api/search?q='+encodeURIComponent(e.target.value));
   $('#res').innerHTML=
    sec('Codebase memory',r.memory.length,r.memory.map(m=>\`<div class="row"><span class="tag acc">\${esc(m.kind)}</span><span class="grow" style="white-space:normal"><b>\${esc(m.title)}</b><br><span class="dim">\${esc(String(m.body).slice(0,280))}</span></span></div>\`).join('')||empty('no memory hits'))+
    sec('Conversations',r.messages.length,r.messages.map(m=>\`<div class="row"><span class="tag \${m.role==='user'?'acc':'blue'}">\${esc(m.role)}</span><span class="grow dim" style="white-space:normal">\${esc(String(m.content).slice(0,280))}</span><span class="faint" style="font-size:10.5px;font-family:var(--mono)">\${new Date(+m.ts).toISOString().slice(0,10)}</span></div>\`).join('')||empty('no conversation hits'));};
 }}
render();
</script></body></html>`;
