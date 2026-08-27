import path from 'node:path';
import { GraphBuilder } from './graph.mjs';
import { scanRepository } from './scan.mjs';
import { createMultiRepoSnapshot } from './identity/snapshot.mjs';

// These nodes describe cross-repository protocol names, not repository-local implementation symbols.
// They are intentionally shared so independently scanned mods meet at the same semantic contract.
const SHARED_KINDS = new Set(['molang_variable', 'animation_name', 'bone_name']);

export async function scanWorkspace(repositories, opts = {}) {
  if (!Array.isArray(repositories) || repositories.length < 2) {
    throw new Error('workspace scan requires at least two repositories');
  }
  const entries = [];
  for (const repo of repositories) {
    if (!repo?.name || !repo?.root) throw new Error('each workspace repository requires name and root');
    const graph = await scanRepository(repo.root, repo.options ?? opts.repositoryOptions ?? {});
    entries.push({ name: repo.name, graph });
  }
  return mergeWorkspaceGraphs(entries);
}

export function mergeWorkspaceGraphs(entries) {
  const names = entries.map(x => x.name);
  const builder = new GraphBuilder(`workspace:${names.join('+')}`);
  builder.addAnalyzer('workspace-merge', 'v1');

  const repoNodes = new Map();
  const maps = new Map();

  for (const { name, graph } of entries) {
    if (!name || !graph?.nodes || !graph?.edges) throw new Error('invalid workspace graph entry');
    if (repoNodes.has(name)) throw new Error(`duplicate workspace repository name: ${name}`);

    const repoNode = builder.node('repository', name, {
      label: name,
      repository: name,
      sourceRoot: graph.root,
      analyzers: graph.meta?.analyzers ?? []
    });
    repoNodes.set(name, repoNode);

    const nodeMap = new Map();
    maps.set(name, nodeMap);

    for (const node of graph.nodes) {
      const shared = SHARED_KINDS.has(node.kind);
      const key = shared ? node.key : `${name}:${node.key}`;
      const data = copyNodeData(node);

      if (node.path) {
        data.sourcePath = node.path;
        data.path = `${name}:${node.path}`;
      }
      if (shared) {
        data.repositories = union(data.repositories, [name]);
        delete data.repository;
      } else {
        data.repository = name;
      }

      const merged = builder.node(node.kind, key, data);
      if (shared) merged.repositories = union(merged.repositories, [name]);
      nodeMap.set(node.id, merged);

      if (node.kind === 'file') {
        builder.edge(repoNode, merged, 'CONTAINS_REPOSITORY_FILE', {
          source: name,
          repository: name,
          confidence: 1
        });
      }
    }

    for (const edge of graph.edges) {
      const from = nodeMap.get(edge.from);
      const to = nodeMap.get(edge.to);
      if (!from || !to) continue;
      const data = copyEdgeData(edge);
      data.repository = name;
      data.originalSource = edge.source ?? null;
      data.source = edge.source ? `${name}:${edge.source}` : name;
      builder.edge(from, to, edge.type, data);
    }
  }

  materializeBoundaryEdges(builder, repoNodes);

  const result = builder.finish();
  result.meta.workspace = {
    repositories: names,
    boundaryEdgeCount: result.edges.filter(e => e.boundary).length,
    sharedKinds: [...SHARED_KINDS]
  };
  result.meta.repositories = entries.map(({ name, graph }) => ({
    name,
    repository: graph.meta?.repository ?? null,
    snapshot: graph.meta?.snapshot ?? null
  }));

  const constituents = result.meta.repositories
    .map(entry => entry.snapshot)
    .filter(Boolean);

  if (constituents.length === entries.length) {
    result.meta.snapshot = createMultiRepoSnapshot(constituents);
  }
  return result;
}

function materializeBoundaryEdges(builder, repoNodes) {
  for (const semantic of builder.graph.nodes.filter(n => SHARED_KINDS.has(n.kind))) {
    const incoming = builder.graph.edges.filter(e => e.to === semantic.id && e.repository);
    if (semantic.kind === 'molang_variable') {
      const producers = reposFor(incoming, new Set(['WRITES_MOLANG']));
      const consumers = reposFor(incoming, new Set(['READS_MOLANG']));
      const cross = hasCrossRepositoryPair(producers, consumers);
      if (!cross) continue;
      semantic.crossRepository = true;
      semantic.repositories = union(semantic.repositories, [...producers, ...consumers]);
      for (const repo of producers) {
        builder.edge(repoNodes.get(repo), semantic, 'BOUNDARY_PRODUCES_MOLANG', {
          source: `boundary:${semantic.key}:${repo}:producer`, boundary: true, semantic: semantic.key, confidence: 1
        });
      }
      for (const repo of consumers) {
        builder.edge(semantic, repoNodes.get(repo), 'BOUNDARY_CONSUMES_MOLANG', {
          source: `boundary:${semantic.key}:${repo}:consumer`, boundary: true, semantic: semantic.key, confidence: 1
        });
      }
    }

    if (semantic.kind === 'animation_name') {
      const dispatchers = reposFor(incoming, new Set(['PLAYS_YSM_ANIMATION', 'DISPATCHES_YSM_ANIMATION']));
      const providers = reposFor(incoming, new Set(['PROVIDES_ANIMATION_NAME']));
      const cross = hasCrossRepositoryPair(dispatchers, providers);
      if (!cross) continue;
      semantic.crossRepository = true;
      semantic.repositories = union(semantic.repositories, [...dispatchers, ...providers]);
      for (const repo of dispatchers) {
        builder.edge(repoNodes.get(repo), semantic, 'BOUNDARY_DISPATCHES_ANIMATION', {
          source: `boundary:${semantic.key}:${repo}:dispatcher`, boundary: true, semantic: semantic.key, confidence: 1
        });
      }
      for (const repo of providers) {
        builder.edge(semantic, repoNodes.get(repo), 'BOUNDARY_PROVIDES_ANIMATION', {
          source: `boundary:${semantic.key}:${repo}:provider`, boundary: true, semantic: semantic.key, confidence: 1
        });
      }
    }
  }
}

function reposFor(edges, types) {
  return new Set(edges.filter(e => types.has(e.type)).map(e => e.repository).filter(Boolean));
}

function hasCrossRepositoryPair(left, right) {
  for (const a of left) for (const b of right) if (a !== b) return true;
  return false;
}

function copyNodeData(node) {
  const { id, kind, key, ...rest } = node;
  return structuredClone(rest);
}

function copyEdgeData(edge) {
  const { id, from, to, type, ...rest } = edge;
  return structuredClone(rest);
}

function union(a = [], b = []) {
  return [...new Set([...(a ?? []), ...(b ?? [])])];
}

export function parseWorkspaceRepoSpec(spec) {
  const eq = spec.indexOf('=');
  if (eq > 0) return { name: spec.slice(0, eq), root: path.resolve(spec.slice(eq + 1)) };
  const root = path.resolve(spec);
  return { name: path.basename(root), root };
}
