import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {
  createViewerAnalysisManifest,
  createViewerDiagram,
  resolveViewerRef
} from './viewer-transport.mjs';

export function createViewerServer({
  viewerRoot,
  graphFile,
  analysisFile = null
}) {
  if (!viewerRoot) throw new TypeError('viewerRoot is required');
  if (!graphFile) throw new TypeError('graphFile is required');

  const root = path.resolve(String(viewerRoot));
  const graphPath = path.resolve(String(graphFile));
  const analysisPath = analysisFile
    ? path.resolve(String(analysisFile))
    : null;

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(
        req.url ?? '/',
        'http://127.0.0.1'
      );
      const requestPath = decodeURIComponent(url.pathname);

      if (requestPath === '/graph.json') {
        return sendJson(res, await readJson(graphPath));
      }

      if (requestPath === '/analysis.json') {
        if (!analysisPath) return notFound(res);
        const result = await readJson(analysisPath);
        return sendJson(
          res,
          createViewerAnalysisManifest(result)
        );
      }

      if (requestPath === '/api/ref') {
        if (!analysisPath) return notFound(res);
        const ref = url.searchParams.get('ref');
        if (!ref) return badRequest(res, 'ref is required');
        const [result, graph] = await Promise.all([
          readJson(analysisPath),
          readJson(graphPath)
        ]);
        const payload = resolveViewerRef(
          result,
          graph,
          ref
        );
        if (!payload) return notFound(res);
        return sendJson(res, payload);
      }

      if (requestPath === '/api/diagram') {
        if (!analysisPath) return notFound(res);
        const [result, graph] = await Promise.all([
          readJson(analysisPath),
          readJson(graphPath)
        ]);
        const payload = createViewerDiagram(
          result,
          graph,
          {
            diagramType:
              url.searchParams.get('type') ?? 'AUTO',
            detailLevel:
              url.searchParams.get('detail') ?? 'focused',
            focusRef:
              url.searchParams.get('focus') || null
          }
        );
        return sendJson(res, payload);
      }

      const rel = requestPath === '/'
        ? 'index.html'
        : requestPath.replace(/^\/+/, '');
      const target = path.resolve(root, rel);
      if (
        target !== root &&
        !target.startsWith(root + path.sep)
      ) {
        res.statusCode = 403;
        res.end('forbidden');
        return;
      }
      const data = await fs.readFile(target);
      res.setHeader(
        'content-type',
        contentType(target)
      );
      res.end(data);
    } catch (error) {
      if (error?.code === 'ENOENT') return notFound(res);
      res.statusCode = 500;
      res.setHeader(
        'content-type',
        'application/json; charset=utf-8'
      );
      res.end(JSON.stringify({
        error: 'VIEWER_SERVER_ERROR',
        message: String(error?.message ?? error)
      }));
    }
  });
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

function sendJson(res, value) {
  res.statusCode = 200;
  res.setHeader(
    'content-type',
    'application/json; charset=utf-8'
  );
  res.end(JSON.stringify(value));
}

function badRequest(res, message) {
  res.statusCode = 400;
  res.setHeader(
    'content-type',
    'application/json; charset=utf-8'
  );
  res.end(JSON.stringify({
    error: 'BAD_REQUEST',
    message
  }));
}

function notFound(res) {
  res.statusCode = 404;
  res.end('not found');
}

function contentType(file) {
  const ext = path.extname(file);
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js' || ext === '.mjs') {
    return 'text/javascript; charset=utf-8';
  }
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  return 'application/octet-stream';
}
