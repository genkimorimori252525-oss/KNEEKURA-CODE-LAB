import {runWorkbenchCli} from './analysis-workbench/cli.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { scanRepository } from './core/scan.mjs';
import { scanWorkspace, parseWorkspaceRepoSpec } from './core/workspace.mjs';
import { writeHumanViewerBundle } from './viewer/bundle.mjs';
import { createExplorerProjection } from './presentation/explorer/project.mjs';

const args = process.argv.slice(2);
const cmd = args.shift();
const flag = (name, fallback=null) => { const i=args.indexOf(name); return i>=0 ? args[i+1] : fallback; };
const flags = name => {
  const values=[];
  for (let i=0;i<args.length;i++) if (args[i]===name && args[i+1]) values.push(args[i+1]);
  return values;
};

if (cmd === 'workbench') {
  await runWorkbenchCli(args);
} else if (cmd === 'scan') {
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
} else if (cmd === 'viewer-bundle') {
  const resultFile = flag('--result');
  const graphFile = flag('--graph');
  if (!resultFile || !graphFile) {
    throw new Error('viewer-bundle requires --result and --graph');
  }
  const outDir = flag('--out','dist/viewer-bundle');
  const [result, graph] = await Promise.all([
    readJson(resultFile),
    readJson(graphFile)
  ]);
  const bundle = await writeHumanViewerBundle({
    result,
    graph,
    outDir
  });
  console.log(
    `KNEEKURA viewer bundle: ${bundle.evidence_count} evidence refs -> ${bundle.root}`
  );
} else if (cmd === 'explorer-projection') {
  const resultFile = flag('--result');
  const graphFile = flag('--graph');
  if (!resultFile || !graphFile) {
    throw new Error(
      'explorer-projection requires --result and --graph'
    );
  }
  const out = flag(
    '--out',
    'dist/explorer-projection.json'
  );
  const [result, graph] = await Promise.all([
    readJson(resultFile),
    readJson(graphFile)
  ]);
  const projection = createExplorerProjection({
    result,
    graph
  });
  await writeGraph(out, projection);
  console.log(
    'KNEEKURA Explorer projection: ' +
    projection.presentation.nodes.length +
    ' nodes / ' +
    projection.presentation.edges.length +
    ' edges -> ' + out
  );
} else if (cmd === 'serve-explorer') {
  const projectionFile = path.resolve(
    flag(
      '--projection',
      'dist/explorer-projection.json'
    )
  );
  const appRoot = path.resolve(
    flag(
      '--app',
      'packages/human-explorer/dist'
    )
  );
  const port = Number(flag('--port','8790'));
  const server = http.createServer(async (req,res)=>{
    try {
      const requestPath = decodeURIComponent(
        new URL(
          req.url,
          'http://127.0.0.1'
        ).pathname
      );
      let target;

      if (requestPath === '/explorer-projection.json') {
        target = projectionFile;
      } else {
        const rel = requestPath === '/'
          ? 'index.html'
          : requestPath.replace(/^\/+/, '');
        target = path.resolve(appRoot, rel);
        if (
          target !== appRoot &&
          !target.startsWith(appRoot + path.sep)
        ) {
          res.statusCode = 403;
          res.end('forbidden');
          return;
        }
      }

      const data = await fs.readFile(target);
      const ext = path.extname(target);
      res.setHeader(
        'content-type',
        ext === '.html'
          ? 'text/html; charset=utf-8'
          : ext === '.js' || ext === '.mjs'
            ? 'text/javascript; charset=utf-8'
            : ext === '.css'
              ? 'text/css; charset=utf-8'
              : 'application/json; charset=utf-8'
      );
      res.end(data);
    } catch {
      res.statusCode=404;
      res.end('not found');
    }
  });
  server.listen(
    port,
    '127.0.0.1',
    () => console.log(
      'KNEEKURA Human Explorer: ' +
      'http://127.0.0.1:' + port
    )
  );
} else if (cmd === 'serve') {
  const bundleArg = flag('--bundle');
  const bundleRoot = bundleArg ? path.resolve(bundleArg) : null;
  const graphFile = path.resolve(flag('--graph','dist/graph.json'));
  const port = Number(flag('--port','8789'));
  const here = path.dirname(fileURLToPath(import.meta.url));
  const viewer = path.resolve(here,'../viewer');
  const server = http.createServer(async (req,res)=>{
    try {
      const requestPath = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      let target;

      if (bundleRoot && isBundleResource(requestPath)) {
        const rel = requestPath.replace(/^\/+/, '');
        target = path.resolve(bundleRoot, rel);
        if (target !== bundleRoot && !target.startsWith(bundleRoot + path.sep)) {
          res.statusCode = 403; res.end('forbidden'); return;
        }
      } else if (!bundleRoot && requestPath === '/graph.json') {
        target = graphFile;
      } else {
        const rel = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
        target = path.resolve(viewer, rel);
        if (target !== viewer && !target.startsWith(viewer + path.sep)) {
          res.statusCode = 403; res.end('forbidden'); return;
        }
      }

      const data = await fs.readFile(target);
      const ext = path.extname(target);
      res.setHeader(
        'content-type',
        ext==='.html'
          ? 'text/html; charset=utf-8'
          : ext==='.js' || ext==='.mjs'
            ? 'text/javascript; charset=utf-8'
            : ext==='.css'
              ? 'text/css; charset=utf-8'
              : 'application/json; charset=utf-8'
      );
      res.end(data);
    } catch {
      res.statusCode=404;
      res.end('not found');
    }
  });
  server.listen(port,'127.0.0.1',()=>console.log(`KNEEKURA-CODE-LAB viewer: http://127.0.0.1:${port}`));
} else {
  console.log('usage:\n  node src/cli.mjs workbench --request request.json --out NEW-directory [--help]\n  node src/cli.mjs scan <repo> --out dist/graph.json [--codegraph file.json] [--understand project-or-graph] [--trace trace.jsonl] [--pose stamp.pose.json] [--palette stamp.pal.json] [--net process.net.jsonl ...] [--allow-v1-pose] [--allow-v1-palette] [--allow-unbound-net]\n  node src/cli.mjs workspace --repo tlm=C:\\path\\to\\tlm --repo ysm=C:\\path\\to\\ysm --out dist/workspace.json\n  node src/cli.mjs viewer-bundle --result dist/analysis-result.json --graph dist/graph.json --out dist/viewer-bundle\n  node src/cli.mjs explorer-projection --result dist/analysis-result.json --graph dist/graph.json --out dist/explorer-projection.json\n  node src/cli.mjs serve-explorer --projection dist/explorer-projection.json [--app packages/human-explorer/dist] [--port 8790]\n  node src/cli.mjs serve --graph dist/graph.json [--port 8789]\n  node src/cli.mjs serve --bundle dist/viewer-bundle [--port 8789]');
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(path.resolve(file), 'utf8'));
}

function isBundleResource(requestPath) {
  return [
    '/viewer-manifest.json',
    '/analysis-result.json',
    '/graph.json'
  ].includes(requestPath) ||
    requestPath.startsWith('/refs/');
}

async function writeGraph(out, graph) {
  await fs.mkdir(path.dirname(out),{recursive:true});
  await fs.writeFile(out,JSON.stringify(graph,null,2));
}
