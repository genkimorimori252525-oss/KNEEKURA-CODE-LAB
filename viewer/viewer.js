const G=await fetch('/graph.json').then(r=>r.json());
const svg=document.querySelector('#graph'),q=document.querySelector('#q'),kind=document.querySelector('#kind'),edgeType=document.querySelector('#edgeType'),boundaryOnly=document.querySelector('#boundaryOnly'),runtimeOnly=document.querySelector('#runtimeOnly'),detail=document.querySelector('#detail'),summary=document.querySelector('#summary');
const workspace=G.meta.workspace;const runtimeEdgeCount=G.edges.filter(e=>e.runtimeObservation).length;const fidelity=G.nodes.find(n=>n.kind==='fidelity_matrix');
const fidelityHtml=fidelity?`<div class="fidelity"><b>YSM fidelity</b><br>observed through <b>${fidelity.observedThroughStage||'none'}</b>${fidelity.firstUnobservedStage?` / next <b>${fidelity.firstUnobservedStage}</b>`:''}<br>${(fidelity.stageSummary||[]).map(s=>`<span class="badge fidelity-${s.status}">${s.id} ${s.status}</span>`).join('')}</div>`:'';
summary.innerHTML=`<b>${G.nodes.length}</b> nodes / <b>${G.edges.length}</b> edges${workspace?`<br><b>${workspace.boundaryEdgeCount||0}</b> boundary edges / ${workspace.repositories.join(' + ')}`:''}${runtimeEdgeCount?`<br><b>${runtimeEdgeCount}</b> runtime observation edges`:''}<br>${Object.entries(G.meta.counts||{}).map(([k,v])=>`<span class="badge">${k}: ${v}</span>`).join('')}`;
for(const k of [...new Set(G.nodes.map(n=>n.kind))].sort())kind.add(new Option(k,k));
for(const t of [...new Set(G.edges.map(e=>e.type))].sort())edgeType.add(new Option(t,t));
const W=1400,H=900,nodes=G.nodes.map((n,i)=>({...n,x:W/2+Math.cos(i)*150+(Math.random()-.5)*400,y:H/2+Math.sin(i)*150+(Math.random()-.5)*400,vx:0,vy:0}));
const byId=new Map(nodes.map(n=>[n.id,n]));const edges=G.edges.map(e=>({...e,a:byId.get(e.from),b:byId.get(e.to)})).filter(e=>e.a&&e.b);
// small deterministic-ish force layout; enough for hundreds of nodes without dependencies.
for(let it=0;it<180;it++){for(const e of edges){let dx=e.b.x-e.a.x,dy=e.b.y-e.a.y,d=Math.hypot(dx,dy)||1,f=(d-90)*.002;dx/=d;dy/=d;e.a.vx+=dx*f;e.a.vy+=dy*f;e.b.vx-=dx*f;e.b.vy-=dy*f}for(let i=0;i<nodes.length;i++){const a=nodes[i];for(let j=i+1;j<Math.min(nodes.length,i+80);j++){const b=nodes[j];let dx=b.x-a.x,dy=b.y-a.y,d2=dx*dx+dy*dy+10;if(d2<9000){const f=18/d2;a.vx-=dx*f;a.vy-=dy*f;b.vx+=dx*f;b.vy+=dy*f}}}for(const n of nodes){n.vx+=(W/2-n.x)*.00006;n.vy+=(H/2-n.y)*.00006;n.vx*=.86;n.vy*=.86;n.x+=n.vx;n.y+=n.vy}}
svg.setAttribute('viewBox',`0 0 ${W} ${H}`);const NS='http://www.w3.org/2000/svg';
for(const e of edges){const l=document.createElementNS(NS,'line');l.classList.add('edge');if(e.boundary)l.classList.add('boundary');if(e.runtimeObservation)l.classList.add('runtime-observation');l.setAttribute('x1',e.a.x);l.setAttribute('y1',e.a.y);l.setAttribute('x2',e.b.x);l.setAttribute('y2',e.b.y);l.dataset.id=e.id;l.dataset.from=e.from;l.dataset.to=e.to;l.dataset.type=e.type;l.dataset.boundary=e.boundary?'1':'0';l.dataset.runtime=e.runtimeObservation?'1':'0';svg.append(l)}
const groups=[];for(const n of nodes){const g=document.createElementNS(NS,'g');g.classList.add('node');if(n.crossRepository)g.classList.add('cross-repository');if(n.runtimeObserved)g.classList.add('runtime-observed');g.setAttribute('transform',`translate(${n.x} ${n.y})`);g.dataset.id=n.id;const c=document.createElementNS(NS,'circle');c.setAttribute('r',radius(n.kind));c.setAttribute('fill',color(n.kind));const t=document.createElementNS(NS,'text');t.setAttribute('x',radius(n.kind)+4);t.setAttribute('y','3');t.textContent=n.label.slice(0,38);g.append(c,t);g.onclick=()=>select(n,g);svg.append(g);groups.push(g)}
function select(n,g){groups.forEach(x=>x.classList.remove('selected'));g.classList.add('selected');const rel=G.edges.filter(e=>e.from===n.id||e.to===n.id).map(e=>({type:e.type,direction:e.from===n.id?'out':'in',other:(byId.get(e.from===n.id?e.to:e.from)||{}).label,repository:e.repository,boundary:!!e.boundary,runtimeObservation:!!e.runtimeObservation,fidelityEvidence:!!e.fidelityEvidence,observationCount:e.observationCount,firstTick:e.firstTick,lastTick:e.lastTick,semantic:e.semantic,confidence:e.confidence,evidence:e.evidence,samples:e.samples}));detail.textContent=JSON.stringify({...n,relations:rel},null,2)}
function filter(){
  const s=q.value.toLowerCase(),k=kind.value,t=edgeType.value,boundary=boundaryOnly.checked,runtime=runtimeOnly.checked;
  let visible=new Set(nodes.filter(n=>(!s||(n.label+' '+n.key+' '+(n.repository||'')+' '+(n.repositories||[]).join(' ')).toLowerCase().includes(s))&&(!k||n.kind===k)).map(n=>n.id));
  if(boundary){const boundaryNodes=new Set(edges.filter(e=>e.boundary).flatMap(e=>[e.from,e.to]));visible=new Set([...visible].filter(id=>boundaryNodes.has(id)))}
  if(runtime){const runtimeNodes=new Set(edges.filter(e=>e.runtimeObservation).flatMap(e=>[e.from,e.to]));visible=new Set([...visible].filter(id=>runtimeNodes.has(id)))}
  for(const g of groups)g.classList.toggle('muted',!visible.has(g.dataset.id));
  for(const l of svg.querySelectorAll('.edge')){
    const endpoints=visible.has(l.dataset.from)&&visible.has(l.dataset.to);
    const typeOk=!t||l.dataset.type===t;
    const boundaryOk=!boundary||l.dataset.boundary==='1';
    const runtimeOk=!runtime||l.dataset.runtime==='1';
    l.classList.toggle('muted',!(endpoints&&typeOk&&boundaryOk&&runtimeOk));
  }
}
q.oninput=filter;kind.onchange=filter;edgeType.onchange=filter;boundaryOnly.onchange=filter;runtimeOnly.onchange=filter;
function radius(k){return k==='repository'||k==='runtime'||k==='fidelity_matrix'?12:k==='mod'?10:k==='runtime_pose_capture'?9:k==='fidelity_capability'||k==='class'||k==='runtime_entity'?8:k==='method'?5:6}function color(k){let h=0;for(const c of k)h=(h*31+c.charCodeAt(0))%360;return `hsl(${h} 58% 52%)`}
