import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { runTypeScriptSemanticVertical } from '../src/analyzer-fabric/typescript-vertical.mjs';
import { createHumanAnalysisEvidencePack } from '../src/human-analysis/evidence-pack.mjs';
import { createHumanAnalysisSourceBroker } from '../src/human-analysis/source-broker.mjs';
import { createAcceptanceSemanticAuthor } from '../src/human-analysis/author-contract.mjs';
import { runAcceptanceHumanAnalysisSemanticPipeline } from '../src/human-analysis/production.mjs';
import { compileHumanAnalysisArtifact, writeHumanAnalysisArtifact } from '../src/human-analysis/artifact-compiler.mjs';

const run = promisify(execFile);
const paths = {
  architecture: 'packages/github/src/client.ts',
  domain: 'packages/orchestration/src/agent-service.ts',
  tour: 'packages/workspace/src/manager.ts'
};
const cmp = (a,b) => String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
const sha = text => 'sha256:' + crypto.createHash('sha256').update(text).digest('hex');
const exec = (command,args,options={}) => run(command,args,{encoding:'utf8',windowsHide:true,maxBuffer:32*1024*1024,...options});
async function npm(cwd,args){
  if(process.env.npm_execpath) return exec(process.execPath,[process.env.npm_execpath,...args],{cwd});
  if(process.platform==='win32') return exec(process.env.ComSpec??'cmd.exe',['/d','/s','/c','npm',...args],{cwd});
  return exec('npm',args,{cwd});
}
async function exists(p){try{await fs.access(p);return true}catch{return false}}
async function loveRoot(){
  const home=os.homedir();
  for(const p of [process.env.LOVE_GITHUB_ROOT,path.join(home,'Downloads','Love-Github'),path.join(home,'Downloads','love-github'),path.join(home,'Desktop','Love-Github'),path.join(home,'Documents','Love-Github')].filter(Boolean)){
    if(!(await exists(path.join(p,'.git')))) continue;
    try{const url=(await exec('git',['-C',p,'remote','get-url','origin'])).stdout.trim();if(/(?:^|[\\/:])Love-Github(?:\.git)?$/i.test(url)) return path.resolve(p)}catch{}
  }
  throw new Error('LIVE_GUIDE_REPO_NOT_FOUND');
}
async function targetCommit(root,source){
  try{
    const url=(await exec('git',['-C',source,'remote','get-url','origin'])).stdout.trim();
    await exec('git',['-C',root,'remote','set-url','origin',url]);
    await exec('git',['-C',root,'fetch','--no-tags','--prune','origin','main']);
    return (await exec('git',['-C',root,'rev-parse','FETCH_HEAD'])).stdout.trim().toLowerCase();
  }catch(error){
    process.stderr.write(`Love-Github fetch unavailable; using local snapshot: ${String(error?.message??error)}\n`);
    return (await exec('git',['-C',root,'rev-parse','HEAD'])).stdout.trim().toLowerCase();
  }
}
function evidenceAt(pack,p){
  const rows=pack.canonical.evidence.filter(e=>e?.provenance?.path===p&&e?.observation?.source_range?.content_digest&&Number.isInteger(e?.provenance?.range?.start_line)&&Number.isInteger(e?.provenance?.range?.end_line)).sort((a,b)=>cmp(a.id,b.id));
  if(!rows.length) throw new Error(`LIVE_GUIDE_MISSING_EVIDENCE:${p}`); return rows[0];
}
function gapAt(pack){
  const rows=pack.canonical.result.coverage.entries.filter(e=>['UNEXPLORED','FAILED','SKIPPED'].includes(e?.status)).sort((a,b)=>cmp(`${a.path}:${a.capability}:${a.id}`,`${b.path}:${b.capability}:${b.id}`));
  if(!rows.length) throw new Error('LIVE_GUIDE_NO_COVERAGE_GAP'); return rows[0];
}
function author(pack){
  const a=evidenceAt(pack,paths.architecture), d=evidenceAt(pack,paths.domain), t=evidenceAt(pack,paths.tour), g=gapAt(pack);
  const file={kind:'FILE_RANGE',path:t.provenance.path,start_line:t.provenance.range.start_line,end_line:t.provenance.range.end_line,content_digest:t.observation.source_range.content_digest};
  return createAcceptanceSemanticAuthor({id:'love-github-live-acceptance-v1',locale:'en',run:async env=>{
    if(env.stage==='ARCHITECTURE') return {items:[{kind:'ARCHITECTURE_COMPONENT',semantic_class:'AI_INTERPRETATION',title:'GitHub request boundary',body:`Resolved compiler evidence in ${paths.architecture} anchors the GitHub request layer.`,source_refs:[{kind:'EVIDENCE',id:a.id}]}]};
    if(env.stage==='DOMAIN') return {items:[{kind:'DOMAIN_CONCEPT',semantic_class:'AI_INTERPRETATION',title:'Agent orchestration',body:`Resolved compiler evidence in ${paths.domain} anchors the orchestration domain.`,source_refs:[{kind:'EVIDENCE',id:d.id}]}]};
    if(env.stage==='FLOW') return {items:[{kind:'FLOW',semantic_class:'COVERAGE_GAP',title:`${g.capability??'Semantic'} coverage remains bounded`,body:String(g.reason??'Canonical CORE coverage is incomplete.'),source_refs:[{kind:'COVERAGE',id:g.id}],confidence:{level:'VERY_HIGH',rationale:'Canonical coverage remains non-complete regardless of AI confidence.'}}]};
    if(env.stage==='TOUR') return {items:[{kind:'TOUR_STEP',semantic_class:'AI_INTERPRETATION',title:`Inspect ${paths.tour}`,body:'Start at this exact snapshot-bound compiler-traced source range.',source_refs:[file],ordering_key:'001'}]};
    if(env.stage==='REVIEWER') return {decisions:env.candidate_items.map(i=>({item_id:i.id,status:'ACCEPT',reason:'Real source/canonical ref verified; authority class preserved.'}))};
    throw new Error(`LIVE_GUIDE_UNEXPECTED_STAGE:${env.stage}`);
  }});
}
async function catalog(root,files){
  const out=[];
  for(const f of files){if(f.primary_language!=='TYPESCRIPT') continue;const raw=await fs.readFile(path.join(root,f.path),'utf8');out.push({path:f.path,content_digest:sha(raw),line_count:raw.split(/\r?\n/).length})}
  return out.sort((a,b)=>cmp(a.path,b.path));
}
async function materialize(ir,broker){
  const out=new Map();
  for(const item of ir.items) for(const ref of item.source_refs??[]){
    const key=ref.kind==='FILE_RANGE'?`FILE_RANGE:${ref.path}:${ref.start_line}:${ref.end_line}:${ref.content_digest}`:`${ref.kind}:${ref.id}`;
    if(out.has(key)) continue;
    if(ref.kind==='FILE_RANGE'){const v=await broker.readFileRange(ref);out.set(key,{ref:structuredClone(ref),instruction_authority:false,trust_class:v.trust_class,content_digest:v.content_digest,text:v.text})}
    else{const v=broker.resolveCanonicalRef(ref);out.set(key,{ref:structuredClone(ref),instruction_authority:false,trust_class:v.trust_class,record:v.record})}
  }
  return [...out.entries()].sort((a,b)=>cmp(a[0],b[0])).map(([,v])=>v);
}

async function main(){
  const source=await loveRoot(), parent=await fs.mkdtemp(path.join(os.tmpdir(),'kneekura-love-guide-')), root=path.join(parent,'repo');
  try{
    await exec('git',['clone','--no-hardlinks','--no-checkout',source,root]);
    const commit=await targetCommit(root,source); await exec('git',['-C',root,'checkout','--detach',commit]);
    await npm(root,['install','--no-audit','--no-fund','--package-lock=false']); await npm(root,['run','typecheck']);
    const targetVersion=String(JSON.parse(await fs.readFile(path.join(root,'node_modules','typescript','package.json'),'utf8')).version);
    const require=createRequire(import.meta.url), mod=require('@typescript/typescript6'), ts=typeof mod?.createProgram==='function'?mod:mod.default;
    const vertical=await runTypeScriptSemanticVertical({rootDirectory:root,commitSha:commit,typescript:ts,expectedTypeScriptVersion:String(ts.version),requireClean:true});
    if(vertical.summary.typescript_files<=0||vertical.summary.evidence<=0) throw new Error('LIVE_GUIDE_EMPTY_VERTICAL');
    if(vertical.summary.canonical_claims!==0) throw new Error('LIVE_GUIDE_CANONICAL_CLAIM_VIOLATION');
    if(vertical.summary.core_coverage_completeness!=='BOUNDED') throw new Error(`LIVE_GUIDE_COVERAGE_OVERCLAIM:${vertical.summary.core_coverage_completeness}`);
    const traced=vertical.execution.observations.filter(o=>o.source_file&&o.source_range?.content_digest&&Number.isInteger(o.source_range?.start_byte)&&Number.isInteger(o.source_range?.end_byte)).length;
    if(traced!==vertical.execution.observations.length) throw new Error(`LIVE_GUIDE_TRACEABILITY_GAP:${traced}/${vertical.execution.observations.length}`);
    const pack=createHumanAnalysisEvidencePack({repository:vertical.repository,snapshot:vertical.snapshot,graph:{nodes:[],edges:[]},result:{claims:vertical.evidence_ledger.claims,unknowns:[],coverage:vertical.evidence_ledger.coverage},evidence:vertical.evidence_ledger.evidence,source_catalog:await catalog(root,vertical.profile.files)});
    const broker=createHumanAnalysisSourceBroker(pack,{readSource:relative=>fs.readFile(path.join(root,relative),'utf8')});
    const ir=await runAcceptanceHumanAnalysisSemanticPipeline({evidencePack:pack,sourceBroker:broker,semanticAuthor:author(pack),request:{question:'Explain Love-Github as a source-linked human guide.',audience:'HUMAN',scope:{type:'REPOSITORY'}}}); if(ir.generation?.mode!=='ACCEPTANCE'||ir.generation?.user_deliverable!==false) throw new Error('LIVE_GUIDE_ACCEPTANCE_MODE_VIOLATION');
    const sources=await materialize(ir,broker), one=compileHumanAnalysisArtifact({ir,sources,title:'Love-Github Human Guide'}), two=compileHumanAnalysisArtifact({ir,sources,title:'Love-Github Human Guide'});
    if(one.artifact_id!==two.artifact_id||one.index_html!==two.index_html||!one.zip_bytes.equals(two.zip_bytes)||one.zip_digest!==two.zip_digest) throw new Error('LIVE_GUIDE_NONDETERMINISTIC_REBUILD');
    const coverage=JSON.parse(one.files.find(f=>f.path==='coverage.json')?.content??'{}'), sourceBundle=JSON.parse(one.files.find(f=>f.path==='sources.json')?.content??'{}');
    if(!coverage.coverage_gaps?.length||!ir.items.some(i=>i.semantic_class==='COVERAGE_GAP')) throw new Error('LIVE_GUIDE_COVERAGE_NOT_VISIBLE');
    if(!ir.items.every(i=>i.source_refs?.length)) throw new Error('LIVE_GUIDE_UNLINKED_ITEM');
    if(!ir.items.some(i=>i.source_refs.some(r=>r.kind==='FILE_RANGE'))) throw new Error('LIVE_GUIDE_NO_DIRECT_SOURCE_RANGE');
    if(!sourceBundle.records?.some(r=>typeof r.text==='string'&&r.text.length>0)||!sourceBundle.records.every(r=>r.instruction_authority===false)) throw new Error('LIVE_GUIDE_SOURCE_BUNDLE_INVALID');
    const written=await writeHumanAnalysisArtifact({artifact:one,outDir:path.join(parent,'guide'),zipFile:'love-github-human-guide.zip'});
    if(await fs.readFile(written.index_path,'utf8')!==one.index_html||!(await fs.readFile(written.zip_path)).equals(one.zip_bytes)) throw new Error('LIVE_GUIDE_WRITE_MISMATCH');
    process.stdout.write(JSON.stringify({schema:'kneekura.live-love-github-human-guide-acceptance/v1',analyzed_commit:commit,target_typescript_version:targetVersion,semantic_sidecar_version:String(ts.version),typescript_files:vertical.summary.typescript_files,observations:vertical.summary.observations,evidence:vertical.summary.evidence,canonical_claims:0,core_coverage:'BOUNDED',exact_source_traces:traced,evidence_pack_id:pack.pack_id,human_ir_digest:ir.ir_digest,human_guide_items:ir.items.length,source_linked_items:ir.items.length,coverage_gap_items:ir.items.filter(i=>i.semantic_class==='COVERAGE_GAP').length,direct_file_range_items:ir.items.filter(i=>i.source_refs.some(r=>r.kind==='FILE_RANGE')).length,artifact_id:one.artifact_id,zip_digest:one.zip_digest,zip_bytes:one.zip_bytes.length,deterministic_rebuild:true},null,2)+'\n');
  }finally{await fs.rm(parent,{recursive:true,force:true})}
}
await main();
