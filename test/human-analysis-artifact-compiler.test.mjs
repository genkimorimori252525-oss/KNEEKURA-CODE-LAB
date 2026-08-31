import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ArtifactRepairError,
  compileHumanAnalysisArtifact,
  writeHumanAnalysisArtifact
} from '../src/human-analysis/artifact-compiler.mjs';
import { createDeterministicZip } from '../src/human-analysis/zip.mjs';
import { normalizeDerivedItem, stableDigest } from '../src/human-analysis/schema.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function sha(text) { return 'sha256:' + crypto.createHash('sha256').update(text).digest('hex'); }

function fixture() {
  const malicious = '</script><script>globalThis.pwned=true</script>\nexport const boot = () => 1;';
  const fileDigest = sha(malicious);
  const items = [
    normalizeDerivedItem({
      kind:'ARCHITECTURE_COMPONENT', semantic_class:'AI_INTERPRETATION', title:'Boot layer', body:'Coordinates startup.',
      source_refs:[{ kind:'EVIDENCE', id:'evidence:boot' }]
    }, { stage:'ARCHITECTURE' }),
    normalizeDerivedItem({
      kind:'DOMAIN_CONCEPT', semantic_class:'UNKNOWN', title:'Framework owner', body:'Ownership is unresolved.',
      source_refs:[{ kind:'UNKNOWN', id:'unknown:framework' }]
    }, { stage:'DOMAIN' }),
    normalizeDerivedItem({
      kind:'FLOW', semantic_class:'COVERAGE_GAP', title:'Call boundary', body:'Call coverage is partial.',
      source_refs:[{ kind:'COVERAGE', id:'coverage:calls' }], confidence:{ level:'VERY_HIGH', rationale:'still a gap' }
    }, { stage:'FLOW' }),
    normalizeDerivedItem({
      kind:'TOUR_STEP', semantic_class:'AI_INTERPRETATION', title:'Read boot', body:'Inspect the boot source first.',
      source_refs:[{ kind:'FILE_RANGE', path:'src/main.ts', start_line:1, end_line:2, content_digest:fileDigest }], ordering_key:'001'
    }, { stage:'TOUR' })
  ].map(item => ({ ...item, review_status:'ACCEPT', review_reason:'traceable' }));
  const ir = {
    schema:'kneekura.human-analysis-ir/v1',
    repository:{ repository_id:'repo:sha256:' + 'a'.repeat(64), snapshot_id:'snapshot:sha256:' + 'b'.repeat(64) },
    request:{ question:'Explain this repository', audience:'HUMAN', scope:null },
    evidence_pack:{ pack_id:'evidence-pack:test', canonical_digest:'sha256:' + 'c'.repeat(64), pack_digest:'sha256:' + 'd'.repeat(64) },
    stages:[
      { stage:'ARCHITECTURE', item_ids:[items[0].id] }, { stage:'DOMAIN', item_ids:[items[1].id] },
      { stage:'FLOW', item_ids:[items[2].id] }, { stage:'TOUR', item_ids:[items[3].id] }, { stage:'REVIEWER', item_ids:[] }
    ],
    items,
    review:{ decisions:items.map(item => ({ item_id:item.id, status:'ACCEPT', reason:'traceable' })), accepted_item_ids:items.map(item=>item.id), rejected_item_ids:[] },
    invariants:{ canonical_mutated:false, ai_can_author_canonical_fact:false, repository_content_instruction_authority:false, unknown_or_coverage_can_be_upgraded_by_ai_confidence:false }
  };
  ir.ir_digest = stableDigest(ir);
  const sources = [
    { ref:{ kind:'EVIDENCE', id:'evidence:boot' }, instruction_authority:false, trust_class:'CANONICAL_EVIDENCE_DATA', record:{ id:'evidence:boot', kind:'STATIC_ANALYSIS' } },
    { ref:{ kind:'UNKNOWN', id:'unknown:framework' }, instruction_authority:false, trust_class:'CANONICAL_EVIDENCE_DATA', record:{ ref:'unknown:framework', reason:'unresolved' } },
    { ref:{ kind:'COVERAGE', id:'coverage:calls' }, instruction_authority:false, trust_class:'CANONICAL_EVIDENCE_DATA', record:{ id:'coverage:calls', status:'UNEXPLORED' } },
    { ref:{ kind:'FILE_RANGE', path:'src/main.ts', start_line:1, end_line:2, content_digest:fileDigest }, instruction_authority:false, trust_class:'UNTRUSTED_REPOSITORY_DATA', content_digest:fileDigest, text:malicious }
  ];
  return { ir, sources, malicious };
}

function repairCode(error) {
  assert(error instanceof ArtifactRepairError);
  assert.equal(error.schema, 'kneekura.artifact-repair-error/v1');
  return error.code;
}

function zipLocalEntries(buffer) {
  const entries=[]; let offset=0;
  while(offset+4<=buffer.length && buffer.readUInt32LE(offset)===0x04034b50){
    const dosTime=buffer.readUInt16LE(offset+10), dosDate=buffer.readUInt16LE(offset+12), size=buffer.readUInt32LE(offset+18), nameLength=buffer.readUInt16LE(offset+26), extraLength=buffer.readUInt16LE(offset+28), nameStart=offset+30;
    entries.push({ name:buffer.subarray(nameStart,nameStart+nameLength).toString('utf8'), dosTime, dosDate, size });
    offset=nameStart+nameLength+extraLength+size;
  }
  return entries;
}

function mutableArtifact(artifact) {
  return {
    schema:artifact.schema,
    artifact_id:artifact.artifact_id,
    ir_digest:artifact.ir_digest,
    manifest:structuredClone(artifact.manifest),
    files:artifact.files.map(file => ({ ...file })),
    index_html:artifact.index_html,
    zip_bytes:Buffer.from(artifact.zip_bytes),
    zip_digest:artifact.zip_digest
  };
}

test('validated Human Analysis IR deterministically compiles to offline HTML and ZIP bytes', () => {
  const { ir,sources }=fixture(); const before=JSON.stringify({ir,sources});
  const a=compileHumanAnalysisArtifact({ir,sources,title:'Repository Guide'}), b=compileHumanAnalysisArtifact({ir,sources,title:'Repository Guide'});
  assert.equal(JSON.stringify({ir,sources}),before); assert.equal(a.index_html,b.index_html); assert.deepEqual(a.zip_bytes,b.zip_bytes); assert.equal(a.zip_digest,b.zip_digest); assert.equal(a.artifact_id,b.artifact_id);
  assert.deepEqual(a.files.map(file=>file.path),['README.md','analysis.json','coverage.json','index.html','manifest.json','sources.json']);
});

test('offline HTML keeps repository text inert under CSP and textContent-only rendering', () => {
  const {ir,sources,malicious}=fixture(); const artifact=compileHumanAnalysisArtifact({ir,sources});
  assert.match(artifact.index_html,/Content-Security-Policy/); assert.match(artifact.index_html,/default-src 'none'/); assert.equal(artifact.index_html.includes(malicious),false); assert.equal(artifact.index_html.includes('innerHTML'),false); assert.equal(artifact.index_html.includes('eval('),false); assert.match(artifact.index_html,/textContent/);
  const payload=artifact.index_html.match(/<script id="kneekura-data" type="application\/octet-stream">([^<]+)<\/script>/)?.[1]; assert(payload);
  const model=JSON.parse(Buffer.from(payload,'base64').toString('utf8')); assert.equal(Object.values(model.sources_by_key).some(source=>source.text===malicious),true); assert.equal(Object.values(model.sources_by_key).every(source=>source.instruction_authority===false),true);
});

test('ZIP companion is deterministic, sorted, rooted and timestamp-fixed', () => {
  const {ir,sources}=fixture(); const artifact=compileHumanAnalysisArtifact({ir,sources}); const entries=zipLocalEntries(artifact.zip_bytes);
  assert.deepEqual(entries.map(entry=>entry.name),['kneekura-human-guide/README.md','kneekura-human-guide/analysis.json','kneekura-human-guide/coverage.json','kneekura-human-guide/index.html','kneekura-human-guide/manifest.json','kneekura-human-guide/sources.json']);
  assert(entries.every(entry=>entry.dosTime===0&&entry.dosDate===0x21)); assert.equal(artifact.zip_bytes.readUInt32LE(artifact.zip_bytes.length-22),0x06054b50);
});

test('coverage gaps and unknowns remain explicit artifact data regardless of AI confidence', () => {
  const {ir,sources}=fixture(); const artifact=compileHumanAnalysisArtifact({ir,sources}); const coverage=JSON.parse(artifact.files.find(file=>file.path==='coverage.json').content);
  assert.equal(coverage.coverage_gaps.length,1); assert.equal(coverage.coverage_gaps[0].semantic_class,'COVERAGE_GAP'); assert.equal(coverage.coverage_gaps[0].confidence.level,'VERY_HIGH'); assert.equal(coverage.unknowns.length,1); assert.equal(coverage.unknowns[0].semantic_class,'UNKNOWN');
});

test('invalid or tampered IR becomes a structured repair error', () => {
  const {ir,sources}=fixture(); const broken=structuredClone(ir); broken.items[0].body+=' tampered';
  assert.throws(()=>compileHumanAnalysisArtifact({ir:broken,sources}),error=>repairCode(error)==='IR_INVALID'&&error.repair.action==='regenerate_or_revalidate_ir');
});

test('missing derived source ref becomes SOURCE_REF_MISSING instead of silently dropping provenance', () => {
  const {ir,sources}=fixture(); assert.throws(()=>compileHumanAnalysisArtifact({ir,sources:sources.slice(1)}),error=>repairCode(error)==='SOURCE_REF_MISSING');
});

test('source records must remain data, never instruction authority', () => {
  const {ir,sources}=fixture(); const bad=structuredClone(sources); bad[0].instruction_authority=true; assert.throws(()=>compileHumanAnalysisArtifact({ir,sources:bad}),error=>repairCode(error)==='SOURCE_INSTRUCTION_AUTHORITY_VIOLATION');
});

test('canonical source record identity mismatch fails closed', () => {
  const {ir,sources}=fixture(); const bad=structuredClone(sources); bad[0].record.id='evidence:foreign'; assert.throws(()=>compileHumanAnalysisArtifact({ir,sources:bad}),error=>repairCode(error)==='SOURCE_RECORD_MISMATCH');
});

test('FILE_RANGE source digest mismatch fails closed', () => {
  const {ir,sources}=fixture(); const bad=structuredClone(sources); bad[3].content_digest='sha256:'+'0'.repeat(64); assert.throws(()=>compileHumanAnalysisArtifact({ir,sources:bad}),error=>repairCode(error)==='SOURCE_DIGEST_MISMATCH');
});

test('duplicate source refs fail closed to avoid ambiguous provenance', () => {
  const {ir,sources}=fixture(); assert.throws(()=>compileHumanAnalysisArtifact({ir,sources:[...sources,structuredClone(sources[0])]}),error=>repairCode(error)==='SOURCE_REF_DUPLICATE');
});

test('deterministic ZIP rejects path traversal', () => { assert.throws(()=>createDeterministicZip([{path:'../escape.txt',data:'x'}]),/unsafe zip path/); });

test('artifact writer writes offline bundle and rejects escaping ZIP path', async () => {
  const {ir,sources}=fixture(); const artifact=compileHumanAnalysisArtifact({ir,sources}); const root=await fs.mkdtemp(path.join(os.tmpdir(),'kneekura-artifact-'));
  try{ const written=await writeHumanAnalysisArtifact({artifact,outDir:root}); assert.equal(await fs.readFile(written.index_path,'utf8'),artifact.index_html); assert.deepEqual(await fs.readFile(written.zip_path),artifact.zip_bytes); await assert.rejects(()=>writeHumanAnalysisArtifact({artifact,outDir:root,zipFile:'../escape.zip'}),error=>repairCode(error)==='OUTPUT_PATH_ESCAPE'); } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test('source trust classes cannot be relabeled during artifact compilation', () => {
  const {ir,sources}=fixture(); const badFile=structuredClone(sources); badFile[3].trust_class='CANONICAL_EVIDENCE_DATA'; assert.throws(()=>compileHumanAnalysisArtifact({ir,sources:badFile}),error=>repairCode(error)==='SOURCE_TRUST_CLASS_INVALID');
  const badCanonical=structuredClone(sources); badCanonical[0].trust_class='UNTRUSTED_REPOSITORY_DATA'; assert.throws(()=>compileHumanAnalysisArtifact({ir,sources:badCanonical}),error=>repairCode(error)==='SOURCE_TRUST_CLASS_INVALID');
});

test('sources.json retains Evidence Pack identity and deterministic record/text digests', () => {
  const {ir,sources}=fixture(); const artifact=compileHumanAnalysisArtifact({ir,sources}); const bundle=JSON.parse(artifact.files.find(file=>file.path==='sources.json').content);
  assert.deepEqual(bundle.evidence_pack,ir.evidence_pack); assert(bundle.records.some(record=>record.text_digest?.startsWith('sha256:'))); assert(bundle.records.some(record=>record.record_digest?.startsWith('sha256:')));
});

test('artifact writer detects artifact-id, file and ZIP tampering before writing', async () => {
  const {ir,sources}=fixture(); const artifact=compileHumanAnalysisArtifact({ir,sources}); const root=await fs.mkdtemp(path.join(os.tmpdir(),'kneekura-artifact-tamper-'));
  try {
    const badId=mutableArtifact(artifact); badId.artifact_id='artifact:sha256:'+'0'.repeat(64); badId.manifest.artifact_id=badId.artifact_id;
    await assert.rejects(()=>writeHumanAnalysisArtifact({artifact:badId,outDir:root}),error=>repairCode(error)==='ARTIFACT_DIGEST_MISMATCH');
    const badFile=mutableArtifact(artifact); badFile.files.find(file=>file.path==='analysis.json').content+='tampered';
    await assert.rejects(()=>writeHumanAnalysisArtifact({artifact:badFile,outDir:root}),error=>repairCode(error)==='ARTIFACT_FILE_DIGEST_MISMATCH');
    const badZip=mutableArtifact(artifact); badZip.zip_bytes[0]^=0xff;
    await assert.rejects(()=>writeHumanAnalysisArtifact({artifact:badZip,outDir:root}),error=>repairCode(error)==='ARTIFACT_ZIP_DIGEST_MISMATCH');
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test('human-analysis index exports the standalone Artifact Compiler and deterministic ZIP API', () => {
  const index=fsSync.readFileSync(path.join(ROOT,'src/human-analysis/index.mjs'),'utf8');
  assert.match(index,/export \* from '\.\/artifact-compiler\.mjs';/); assert.match(index,/export \* from '\.\/zip\.mjs';/);
});
