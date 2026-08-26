import path from 'node:path';
import { GraphBuilder } from './graph.mjs';
import { walk } from './walk.mjs';
import { analyzeJava } from '../analyzers/java.mjs';
import { analyzeForgeJava, analyzeModsToml } from '../analyzers/forge.mjs';
import { analyzeMinecraftJavaBridge, analyzeMinecraftJson } from '../analyzers/minecraft.mjs';
import { importCodeGraph } from '../adapters/codegraph.mjs';
import { importRuntimeTrace } from '../adapters/runtime-trace.mjs';
import { importUnderstandAnything } from '../adapters/understand-anything.mjs';

export async function scanRepository(root, opts={}) {
  root = path.resolve(root);
  const b = new GraphBuilder(root);
  b.addAnalyzer('builtin-java','lexical-v1');
  b.addAnalyzer('forge-semantics','v2');
  b.addAnalyzer('minecraft-ysm-semantics','v2');
  const files = await walk(root);
  for (const file of files) {
    try {
      if (file.endsWith('.java')) {
        const j = await analyzeJava(b,file,root);
        analyzeForgeJava(b,j);
        analyzeMinecraftJavaBridge(b,j);
      } else if (file.endsWith('mods.toml')) {
        await analyzeModsToml(b,file,root);
      } else if (file.endsWith('.json')) {
        await analyzeMinecraftJson(b,file,root);
      }
    } catch (e) {
      b.diagnostic('error','analysis failed',{ file:path.relative(root,file), error:String(e?.stack||e) });
    }
  }
  if (opts.codegraph) await importCodeGraph(b, opts.codegraph);
  if (opts.understand) await importUnderstandAnything(b, opts.understand);
  if (opts.trace) await importRuntimeTrace(b, opts.trace);
  return b.finish();
}
