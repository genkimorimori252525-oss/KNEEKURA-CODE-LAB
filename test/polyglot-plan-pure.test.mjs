import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPolyglotProviderPlan, createPolyglotProviderCatalog } from '../src/analyzer-fabric/polyglot.mjs';

const file=(path,primary_language,{roles=['SOURCE'],format=null,tags=[],embedded_languages=[]}={})=>({path,primary_language,roles,format,tags,embedded_languages});

test('maintained catalog encodes scheduling sources without truth priority',()=>{
  const c=createPolyglotProviderCatalog();
  const keys=c.maintained_precise_indexers.map(x=>x.provider_key);
  for(const key of ['scip-go','scip-typescript','scip-clang','scip-java','rust-analyzer','scip-python','scip-ruby','scip-dotnet']) assert(keys.includes(key),key);
  assert.equal(c.invariants.provider_priority_decides_truth,false);
  assert.equal(c.invariants.missing_tool_means_absent,false);
});

test('TypeScript and Java prefer maintained semantics while legacy analyzers remain fallback/enrichment',()=>{
  const p=buildPolyglotProviderPlan({files:[
    file('src/a.ts','TYPESCRIPT'),
    file('src/Main.java','JAVA'),
    file('mods.toml','TOML',{roles:['CONFIG'],format:'TOML',tags:['minecraft-forge']})
  ]});
  const ts=p.files.find(x=>x.path==='src/a.ts').strategies;
  assert.equal(ts[0].provider_key,'typescript-compiler-semantic');
  assert.equal(ts[0].role,'PRIMARY_COMPILER_SEMANTIC');
  assert(ts.findIndex(x=>x.provider_key==='tree-sitter')>0);
  const java=p.files.find(x=>x.path==='src/Main.java').strategies;
  assert.equal(java[0].provider_key,'scip-java');
  assert(java.findIndex(x=>x.provider_key==='tree-sitter')>java.findIndex(x=>x.provider_key==='scip-java'));
  assert(java.findIndex(x=>x.provider_key==='builtin-java')>java.findIndex(x=>x.provider_key==='tree-sitter'));
  assert(java.some(x=>x.provider_key==='forge-semantics'&&x.role==='DOMAIN_ENRICHMENT'));
  assert(java.every(x=>x.provider_priority_decides_truth===false));
});

test('major maintained languages map to current precise indexers and missing tools stay UNEXPLORED',()=>{
  const cases=[['PYTHON','scip-python'],['GO','scip-go'],['RUST','rust-analyzer'],['C','scip-clang'],['CPP','scip-clang'],['CSHARP','scip-dotnet'],['RUBY','scip-ruby'],['KOTLIN','scip-java'],['SCALA','scip-java']];
  const p=buildPolyglotProviderPlan({files:cases.map(([lang],i)=>file(`src/f${i}.${lang.toLowerCase()}`,lang))});
  for(let i=0;i<cases.length;i++){
    const [lang,key]=cases[i], strategies=p.files.find(x=>x.primary_language===lang).strategies;
    assert.equal(strategies[0].provider_key,key,lang);
    assert.equal(strategies[0].tool_status,'UNEXPLORED',lang);
    assert.equal(strategies[0].execution_status,'UNEXPLORED',lang);
  }
});

test('explicit unavailable semantic tools do not erase syntax/legacy fallback or imply absence',()=>{
  const p=buildPolyglotProviderPlan({files:[file('src/Main.java','JAVA')]},{toolAvailability:{'scip-java':false,'tree-sitter':true}});
  const s=p.files[0].strategies;
  assert.equal(s.find(x=>x.provider_key==='scip-java').tool_status,'UNAVAILABLE');
  assert.equal(s.find(x=>x.provider_key==='tree-sitter').tool_status,'AVAILABLE');
  assert.equal(s.find(x=>x.provider_key==='builtin-java').tool_status,'AVAILABLE');
  assert.equal(p.invariants.missing_tool_means_absent,false);
});

test('config/build formats use structural planning without inventing resolved semantic authority',()=>{
  const p=buildPolyglotProviderPlan({files:[
    file('build.gradle','GROOVY',{roles:['BUILD','CONFIG'],format:'GROOVY'}),
    file('.github/workflows/ci.yml','YAML',{roles:['BUILD','CONFIG'],format:'GITHUB_ACTIONS'}),
    file('config.json','JSON',{roles:['STRUCTURED_DATA'],format:'JSON'})
  ]});
  for(const f of p.files){
    assert.equal(f.strategies[0].provider_key,'ast-grep');
    assert.equal(f.strategies[0].authority_level,'STRUCTURAL_EVIDENCE');
    assert.equal(f.strategies[0].semantic_identity_support,false);
  }
});

test('unknown mixed-language path remains explicit UNEXPLORED rather than ABSENT',()=>{
  const p=buildPolyglotProviderPlan({files:[file('assets/blob.weird',null,{roles:['UNKNOWN']})]});
  assert.equal(p.files[0].strategies[0].role,'EXPLICIT_UNEXPLORED_FALLBACK');
  assert.equal(p.files[0].strategies[0].tool_status,'UNEXPLORED');
  assert.deepEqual(p.summary.explicit_unexplored_paths,['assets/blob.weird']);
});

test('language-specific maintained support does not overclaim Kotlin cross-repository or SCIP relationships',()=>{
  const p=buildPolyglotProviderPlan({files:[file('src/A.kt','KOTLIN'),file('src/A.java','JAVA')]});
  const kotlin=p.files.find(x=>x.primary_language==='KOTLIN').strategies[0];
  const java=p.files.find(x=>x.primary_language==='JAVA').strategies[0];
  assert.equal(kotlin.provider_key,'scip-java');
  assert.equal(kotlin.cross_repository,false);
  assert.equal(java.cross_repository,true);
  assert.equal(kotlin.capability_contracts.find(x=>x.capability==='REFERENCE').support_status,'AVAILABLE');
  assert.equal(kotlin.capability_contracts.find(x=>x.capability==='INHERITANCE').support_status,'PARTIAL');
});

test('catalog keeps per-language support rows when one indexer has different feature support',()=>{
  const rows=createPolyglotProviderCatalog().maintained_precise_indexers.filter(x=>x.provider_key==='scip-java');
  const byLanguage=new Map(rows.map(row=>[row.language_profile,row]));
  assert.equal(byLanguage.get('JAVA').cross_repository,true);
  assert.equal(byLanguage.get('SCALA').cross_repository,true);
  assert.equal(byLanguage.get('KOTLIN').cross_repository,false);
});
