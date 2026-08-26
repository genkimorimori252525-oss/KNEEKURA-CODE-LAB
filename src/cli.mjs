import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { scanRepository } from './core/scan.mjs';

const args = process.argv.slice(2);
const cmd = args.shift();
const flag = (name, fallback=null) => { const i=args.indexOf(name); return i>=0 ? args[i+1] : fallback; };

if (cmd === 'scan') {
  const root = args.find(x=>!x.startsWith('--')) ?? '.';
  const out = flag('--out','dist/graph.json');
  const graph = await scanRepository(root,{ codegraph:flag('--codegraph'), trace:flag('--trace') });
  await fs.mkdir(path.dirname(out),{recursive:true});
  await fs.writeFile(out,JSON.stringify(graph,null,2));
  console.log(`KNEEKURA graph: ${graph.nodes.length} nodes / ${graph.edges.length} edges -> ${out}`);
} else if (cmd === 'serve') {
  const graphFile = path.resolve(flag('--graph','dist/graph.json'));
  const port = Number(flag('--port','8789'));
  const here = path.dirname(fileURLToPath(import.meta.url));
  const viewer = path.resolve(here,'../viewer');
  const server = http.createServer(async (req,res)=>{
    try {
      let target;
      if (req.url === '/graph.json') target = graphFile;
      else target = path.join(viewer, req.url === '/' ? 'index.html' : req.url.replace(/^\//,''));
      const data = await fs.readFile(target);
      const ext = path.extname(target);
      res.setHeader('content-type', ext==='.html'?'text/html; charset=utf-8':ext==='.js'?'text/javascript; charset=utf-8':ext==='.css'?'text/css; charset=utf-8':'application/json; charset=utf-8');
      res.end(data);
    } catch { res.statusCode=404; res.end('not found'); }
  });
  server.listen(port,'127.0.0.1',()=>console.log(`KNEEKURA-CODE-LAB viewer: http://127.0.0.1:${port}`));
} else {
  console.log('usage:\n  node src/cli.mjs scan <repo> --out dist/graph.json [--codegraph file.json] [--trace trace.jsonl]\n  node src/cli.mjs serve --graph dist/graph.json [--port 8789]');
}
