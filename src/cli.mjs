import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanRepository } from './core/scan.mjs';
import { scanWorkspace, parseWorkspaceRepoSpec } from './core/workspace.mjs';
import { createViewerServer } from './core/render/viewer-server.mjs';

const args = process.argv.slice(2);
const cmd = args.shift();
const flag = (name, fallback=null) => { const i=args.indexOf(name); return i>=0 ? args[i+1] : fallback; };
const flags = name => {
  const values=[];
  for (let i=0;i<args.length;i++) if (args[i]===name && args[i+1]) values.push(args[i+1]);
  return values;
};

if (cmd === 'scan') {
  const root = args.find(x=>!x.startsWith('--')) ?? '.';
  const out = flag('--out','dist/graph.json');
  const graph = await scanRepository(root,{ codegraph:flag('--codegraph'), understand:flag('--understand'), trace:flag('--trace'), pose:flag('--pose'), palette:flag('--palette'), network:flags('--net'), allowV1Pose:args.includes('--allow-v1-pose'), allowV1Palette:args.includes('--allow-v1-palette'), allowUnboundNet:args.includes('--allow-unbound-net') });
  await writeGraph(out, graph);
  console.log(`KNEEKURA graph: ${graph.nodes.length} nodes / ${graph.edges.length} edges -> ${out}`);
} else if (cmd === 'workspace') {
  const specs = flags('--repo');
  if (specs.length < 2) throw new Error('workspace requires at least two --repo name=path arguments');
  const repos = specs.map(parseWorkspaceRepoSpec);
  const out = flag('--out','dist/workspace.json');
  const graph = await scanWorkspace(repos);
  await writeGraph(out, graph);
  const boundary = graph.meta.workspace?.boundaryEdgeCount ?? 0;
  console.log(`KNEEKURA workspace: ${repos.map(r=>r.name).join(' + ')} -> ${graph.nodes.length} nodes / ${graph.edges.length} edges / ${boundary} boundary edges -> ${out}`);
} else if (cmd === 'serve') {
  const graphFile = path.resolve(flag('--graph','dist/graph.json'));
  const analysisArg = flag('--analysis');
  const analysisFile = analysisArg ? path.resolve(analysisArg) : null;
  const port = Number(flag('--port','8789'));
  const here = path.dirname(fileURLToPath(import.meta.url));
  const viewer = path.resolve(here,'../viewer');
  const server = createViewerServer({
    viewerRoot: viewer,
    graphFile,
    analysisFile
  });
  server.listen(port,'127.0.0.1',()=>{
    console.log(
      `KNEEKURA-CODE-LAB viewer: http://127.0.0.1:${port}` +
      (analysisFile
        ? ' [AnalysisResult mode]'
        : ' [graph compatibility mode]')
    );
  });
} else {
  console.log('usage:\n  node src/cli.mjs scan <repo> --out dist/graph.json [--codegraph file.json] [--understand project-or-graph] [--trace trace.jsonl] [--pose stamp.pose.json] [--palette stamp.pal.json] [--net process.net.jsonl ...] [--allow-v1-pose] [--allow-v1-palette] [--allow-unbound-net]\n  node src/cli.mjs workspace --repo tlm=C:\\path\\to\\tlm --repo ysm=C:\\path\\to\\ysm --out dist/workspace.json\n  node src/cli.mjs serve --graph dist/graph.json [--analysis dist/analysis.json] [--port 8789]');
}

async function writeGraph(out, graph) {
  await fs.mkdir(path.dirname(out),{recursive:true});
  await fs.writeFile(out,JSON.stringify(graph,null,2));
}
