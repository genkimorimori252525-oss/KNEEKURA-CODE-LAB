import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { scanRepository } from './core/scan.mjs';
import { scanWorkspace, parseWorkspaceRepoSpec } from './core/workspace.mjs';

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
  const graph = await scanRepository(root,{ codegraph:flag('--codegraph'), understand:flag('--understand'), trace:flag('--trace') });
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
  const port = Number(flag('--port','8789'));
  const here = path.dirname(fileURLToPath(import.meta.url));
  const viewer = path.resolve(here,'../viewer');
  const server = http.createServer(async (req,res)=>{
    try {
      const requestPath = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      let target;
      if (requestPath === '/graph.json') target = graphFile;
      else {
        const rel = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
        target = path.resolve(viewer, rel);
        if (target !== viewer && !target.startsWith(viewer + path.sep)) {
          res.statusCode = 403; res.end('forbidden'); return;
        }
      }
      const data = await fs.readFile(target);
      const ext = path.extname(target);
      res.setHeader('content-type', ext==='.html'?'text/html; charset=utf-8':ext==='.js'?'text/javascript; charset=utf-8':ext==='.css'?'text/css; charset=utf-8':'application/json; charset=utf-8');
      res.end(data);
    } catch { res.statusCode=404; res.end('not found'); }
  });
  server.listen(port,'127.0.0.1',()=>console.log(`KNEEKURA-CODE-LAB viewer: http://127.0.0.1:${port}`));
} else {
  console.log('usage:\n  node src/cli.mjs scan <repo> --out dist/graph.json [--codegraph file.json] [--understand project-or-graph] [--trace trace.jsonl]\n  node src/cli.mjs workspace --repo tlm=C:\\path\\to\\tlm --repo ysm=C:\\path\\to\\ysm --out dist/workspace.json\n  node src/cli.mjs serve --graph dist/graph.json [--port 8789]');
}

async function writeGraph(out, graph) {
  await fs.mkdir(path.dirname(out),{recursive:true});
  await fs.writeFile(out,JSON.stringify(graph,null,2));
}
