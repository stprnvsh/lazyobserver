/** The dashboard page — self-contained, zero external assets, localhost only. */
export const DASHBOARD_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>lazyobserver</title>
<style>
:root{--bg:#0f141a;--panel:#161d26;--line:#26303c;--text:#dbe4ee;--dim:#8296ab;--acc:#4cc38a;--warn:#e5b567;--bad:#e0685e}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 -apple-system,system-ui,sans-serif;background:var(--bg);color:var(--text)}
header{display:flex;align-items:center;gap:16px;padding:14px 20px;border-bottom:1px solid var(--line)}
header h1{font-size:15px;margin:0;color:var(--acc)}header input{background:var(--panel);border:1px solid var(--line);color:var(--text);border-radius:6px;padding:5px 8px}
nav{display:flex;gap:4px}nav button{background:none;border:none;color:var(--dim);padding:6px 12px;border-radius:6px;cursor:pointer;font-size:13px}
nav button.on{background:var(--panel);color:var(--text)}
main{max-width:1060px;margin:0 auto;padding:20px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:18px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.card b{display:block;font-size:20px}.card span{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.4px}
section{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:14px}
section h2{font-size:12px;text-transform:uppercase;color:var(--dim);margin:0 0 10px;letter-spacing:.5px}
.row{display:flex;gap:8px;padding:5px 0;border-bottom:1px solid var(--line);font-size:13px}.row:last-child{border:0}
.tag{font-size:10px;padding:1px 7px;border-radius:9px;border:1px solid var(--line);color:var(--dim);white-space:nowrap;align-self:center}
.tag.in_progress{color:var(--acc);border-color:var(--acc)}.tag.blocked{color:var(--bad);border-color:var(--bad)}
.tag.review{color:var(--warn);border-color:var(--warn)}.tag.done{opacity:.55}
.dim{color:var(--dim)}.grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
pre{white-space:pre-wrap;font:12px/1.5 ui-monospace,monospace;color:var(--text);margin:0}
input.search{width:100%;background:var(--bg);border:1px solid var(--line);color:var(--text);border-radius:8px;padding:9px 12px;margin-bottom:12px}
a{color:var(--acc);text-decoration:none}.exports a{margin-right:12px}
</style></head><body>
<header><h1>lazyobserver</h1>
<input type="date" id="date">
<nav><button data-v="today" class="on">Today</button><button data-v="tasks">Tasks</button><button data-v="journal">Journal</button><button data-v="search">Search</button></nav>
<div style="flex:1"></div><div class="exports" id="exports"></div>
</header>
<main id="main">loading…</main>
<script>
const $=s=>document.querySelector(s);const main=$('#main');const dateEl=$('#date');
dateEl.value=new Date().toLocaleDateString('en-CA');let view='today';
document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>{view=b.dataset.v;document.querySelectorAll('nav button').forEach(x=>x.classList.toggle('on',x===b));render()});
dateEl.onchange=render;
const esc=s=>String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;');
const t=ms=>new Date(+ms).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
const pj=s=>{try{return JSON.parse(s||'{}')||{}}catch(e){return{}}}; // one bad payload must never kill a view
async function api(p){const r=await fetch(p);if(!r.ok)throw new Error(p+' -> '+r.status);return r.json()}
function exportLinks(){const d=dateEl.value;$('#exports').innerHTML=\`<a href="/export/\${d}.md">md</a><a href="/export/\${d}.html">html</a><a href="/export/\${d}.json">json</a>\`}
async function render(){try{await renderView()}catch(err){main.innerHTML=\`<section><h2>error</h2><pre>\${esc(err.stack||err)}</pre></section>\`}}
async function renderView(){exportLinks();main.innerHTML='loading…';
 if(view==='today'){const r=await api('/api/report?date='+dateEl.value);const ev=await api('/api/events?date='+dateEl.value);
  const T=r.totals;main.innerHTML=\`
  <div class="cards">
   <div class="card"><b>\${T.sessions}</b><span>sessions · \${T.minutes}m</span></div>
   <div class="card"><b>\${r.tasks.doneToday.length}</b><span>tasks done today</span></div>
   <div class="card"><b>\${r.tasks.percentDone}%</b><span>tracked tasks done</span></div>
   <div class="card"><b>\${(T.tokensIn+T.tokensOut).toLocaleString()}</b><span>tokens · $\${T.costUsd.toFixed(2)}</span></div>
   <div class="card"><b>\${T.userPrompts} → \${T.agentActions}</b><span>user → agent</span></div>
  </div>
  <section><h2>Sessions</h2>\${r.material.sessions.map(s=>\`<div class="row"><span class="tag">\${esc(s.surface)}</span><span class="grow">\${esc(s.repo.split('/').pop())} @ \${esc(s.branch)}</span><span class="dim">\${s.minutes}m · \${(s.tokens_in+s.tokens_out).toLocaleString()} tok · \${esc(s.model)}</span></div>\`).join('')||'<span class="dim">none</span>'}</section>
  <section><h2>Decisions</h2>\${r.decisions.map(d=>\`<div class="row"><span class="grow"><b>\${esc(d.choice)}</b> — \${esc(d.rationale)}</span><span class="tag">\${esc(d.proposed_by)}→\${esc(d.decided_by)}</span></div>\`).join('')||'<span class="dim">none</span>'}</section>
  <section><h2>Event timeline (\${ev.length})</h2>\${ev.slice(-200).map(e=>\`<div class="row"><span class="dim">\${t(e.ts)}</span><span class="tag \${e.actor==='user'?'in_progress':''}">\${esc(e.actor)}</span><span class="tag">\${esc(e.kind)}</span><span class="grow dim">\${(p=>esc((p.tool_input||{}).file_path||(p.tool_input||{}).command||p.prompt||''))(pj(e.payload))}</span>\${e.task_id?\`<span class="tag">\${esc(e.task_id)}</span>\`:''}</div>\`).join('')}</section>\`;
 } else if(view==='tasks'){const tasks=await api('/api/tasks');
  const groups={in_progress:'In progress',review:'Review',blocked:'Blocked',todo:'To do',done:'Done'};
  main.innerHTML=Object.entries(groups).map(([k,label])=>{const g=tasks.filter(x=>x.status===k);if(!g.length)return'';
   return \`<section><h2>\${label} (\${g.length})</h2>\${g.map(x=>{const d=pj(x.description);
    return \`<div class="row"><span class="tag \${x.status}">\${esc(x.source)}</span><span class="grow"><a href="\${esc(x.url)}" target="_blank">\${esc(x.source_id)}</a> \${esc(x.title)}</span><span class="dim">\${esc(x.sprint||'')} \${d.due?'due '+esc(d.due):''} \${x.branch?'· '+esc(x.branch):''}</span></div>\`}).join('')}</section>\`}).join('')||'<section><span class="dim">no tasks — lzo tasks sync</span></section>';
 } else if(view==='journal'){const rows=await api('/api/journal?date='+dateEl.value);
  const doc=rows.find(x=>x.kind==='day_doc');const notes=rows.filter(x=>x.kind==='entry');
  main.innerHTML=\`<section><h2>Day document</h2>\${doc?\`<b>\${esc(doc.title)}</b><pre>\${esc(doc.body)}</pre>\`:'<span class="dim">none — run lzo eod</span>'}</section>
  <section><h2>Notes (\${notes.length})</h2>\${notes.map(n=>\`<div class="row"><span class="grow"><b>\${esc(n.title)}</b> \${esc(n.body)}</span></div>\`).join('')||'<span class="dim">none</span>'}</section>\`;
 } else if(view==='search'){main.innerHTML=\`<input class="search" id="q" placeholder="search memory + conversations… (enter)"><div id="res"></div>\`;
  $('#q').onkeydown=async e=>{if(e.key!=='Enter')return;const r=await api('/api/search?q='+encodeURIComponent(e.target.value));
   $('#res').innerHTML=\`<section><h2>Memory (\${r.memory.length})</h2>\${r.memory.map(m=>\`<div class="row"><span class="tag">\${esc(m.kind)}</span><span class="grow"><b>\${esc(m.title)}</b><br><span class="dim">\${esc(String(m.body).slice(0,240))}</span></span></div>\`).join('')}</section>
   <section><h2>Conversations (\${r.messages.length})</h2>\${r.messages.map(m=>\`<div class="row"><span class="tag">\${esc(m.role)}</span><span class="grow dim">\${esc(String(m.content).slice(0,240))}</span></div>\`).join('')}</section>\`};
 }}
render();
</script></body></html>`;
