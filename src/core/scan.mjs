import path from 'node:path';
import { GraphBuilder } from './graph.mjs';
import { walk } from './walk.mjs';
import { resolveRepositoryIdentity } from './identity/repository.mjs';
import {
  assertWorkspaceSnapshotUnchanged,
  captureWorkspaceSnapshot
} from './identity/snapshot.mjs';
import { acquireAndRecord } from './evidence/provider.mjs';
import {
  javaLexicalProvider,
  forgeJavaProvider,
  forgeNetworkProvider,
  minecraftJavaProvider,
  forgeModsTomlProvider,
  minecraftJsonProvider,
  codeGraphProvider,
  understandAnythingProvider,
  runtimeTraceProvider,
  poseCompanionProvider,
  paletteCompanionProvider,
  networkCompanionProvider
} from './evidence/providers.mjs';
import { detectPlatformProfile } from '../analyzers/platform.mjs';
import { deriveNetworkDeliveryMatrix, deriveMolangTransportMatrices } from '../adapters/network-companion.mjs';
import { deriveYsmFidelityMatrix } from '../analyzers/fidelity.mjs';

export async function scanRepository(root, opts={}) {
  root = path.resolve(root);
  const b = new GraphBuilder(root);
  b.addAnalyzer('builtin-java','lexical-v1');
  b.addAnalyzer('forge-semantics','v2');
  b.addAnalyzer('minecraft-ysm-semantics','v2');
  const files = await walk(root);
  const repositoryIdentity =
    opts.repositoryIdentity ??
    await resolveRepositoryIdentity(root, opts.identity ?? {});
  const snapshotIdentity =
    await captureWorkspaceSnapshot(root, repositoryIdentity, { files });
  b.graph.meta.repository = repositoryIdentity;
  b.graph.meta.snapshot = snapshotIdentity;

  const providerContext = {
    builder: b,
    root,
    repository: repositoryIdentity,
    snapshot: snapshotIdentity
  };

  await detectPlatformProfile(b, root, files);
  b.addAnalyzer('forge-1.20.1-network','v1');

  for (const file of files) {
    try {
      if (file.endsWith('.java')) {
        const javaResult = await acquireAndRecord(
          javaLexicalProvider,
          providerContext,
          { file }
        );
        const java = javaResult.value;
        if (!java) continue;

        await acquireAndRecord(forgeJavaProvider, providerContext, { file, java });
        await acquireAndRecord(forgeNetworkProvider, providerContext, { file, java });
        await acquireAndRecord(minecraftJavaProvider, providerContext, { file, java });
      } else if (file.endsWith('mods.toml')) {
        await acquireAndRecord(forgeModsTomlProvider, providerContext, { file });
      } else if (file.endsWith('.json')) {
        await acquireAndRecord(minecraftJsonProvider, providerContext, { file });
      }
    } catch (e) {
      b.diagnostic('error','provider orchestration failed',{
        file:path.relative(root,file),
        code:'INTERNAL_INVARIANT',
        error:String(e?.stack||e)
      });
    }
  }

  if (opts.codegraph) {
    await acquireAndRecord(codeGraphProvider, providerContext, {
      file: opts.codegraph,
      artifact: true
    });
  }
  if (opts.understand) {
    await acquireAndRecord(understandAnythingProvider, providerContext, {
      file: opts.understand,
      artifact: true
    });
  }
  if (opts.trace) {
    await acquireAndRecord(runtimeTraceProvider, providerContext, {
      file: opts.trace,
      artifact: true
    });
  }
  if (opts.pose) {
    await acquireAndRecord(poseCompanionProvider, providerContext, {
      file: opts.pose,
      artifact: true,
      dependencyFiles: opts.trace ? [opts.trace] : [],
      options: { trace: opts.trace, allowV1: opts.allowV1Pose }
    });
  }
  if (opts.palette) {
    await acquireAndRecord(paletteCompanionProvider, providerContext, {
      file: opts.palette,
      artifact: true,
      dependencyFiles: opts.trace ? [opts.trace] : [],
      options: { trace: opts.trace, allowV1: opts.allowV1Palette }
    });
  }
  for (const net of opts.network ?? []) {
    await acquireAndRecord(networkCompanionProvider, providerContext, {
      file: net,
      artifact: true,
      dependencyFiles: opts.trace ? [opts.trace] : [],
      options: { trace: opts.trace, allowUnbound: opts.allowUnboundNet }
    });
  }

  if (b.graph.nodes.some(n => n.kind === 'runtime_network_capture')) {
    deriveNetworkDeliveryMatrix(b);
    deriveMolangTransportMatrices(b);
  }
  if (opts.trace || opts.pose || opts.palette) deriveYsmFidelityMatrix(b);

  if (snapshotIdentity.kind === 'WORKSPACE') {
    const currentFiles = await walk(root);
    const currentSnapshot = await captureWorkspaceSnapshot(
      root,
      repositoryIdentity,
      { files: currentFiles }
    );
    assertWorkspaceSnapshotUnchanged(snapshotIdentity, currentSnapshot);
  }

  return b.finish();
}
