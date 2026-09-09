import fs from 'node:fs/promises';

const [,, role, inputPath, outputPath] = process.argv;
if (!role || !inputPath || !outputPath) {
  throw new Error('usage: node ua-target-acceptance-role.mjs <role> <input> <output>');
}
const input = JSON.parse(await fs.readFile(inputPath, 'utf8'));
let output;

if (role === 'project-scanner') {
  const languages = [...new Set((input.scan?.files ?? []).map(file => file.language).filter(Boolean))].sort();
  output = {
    name: input.acceptanceTarget ?? 'pinned-target',
    description: 'Pinned target repository analyzed through the upstream Understand Anything role contract.',
    languages,
    frameworks: []
  };
} else if (role === 'file-analyzer') {
  const nodes = (input.batchFiles ?? []).map(file => ({
    id: `${nodeType(file)}:${file.path}`,
    type: nodeType(file),
    name: file.path.split('/').at(-1),
    filePath: file.path,
    summary: `${file.path} is a tracked source artifact in the pinned target snapshot.`,
    tags: ['pinned-target', 'acceptance', String(file.fileCategory ?? 'source')],
    complexity: Number(file.sizeLines ?? 0) > 250 ? 'moderate' : 'simple'
  }));
  output = { nodes, edges: [] };
} else if (role === 'assemble-reviewer') {
  output = { issues: [], warnings: [] };
} else if (role === 'architecture-analyzer') {
  const fileNodes = (input.nodes ?? []).filter(node => isFileLevel(node.type));
  output = [{
    id: 'layer:pinned-target',
    name: 'Pinned target',
    description: 'All file-level nodes derived from the exact pinned target snapshot.',
    nodeIds: fileNodes.map(node => node.id)
  }];
} else if (role === 'tour-builder') {
  const nodes = (input.nodes ?? []).filter(node => isFileLevel(node.type)).slice(0, 5);
  output = nodes.length ? [{
    order: 1,
    title: 'Pinned target overview',
    description: 'Start with representative files from the exact pinned snapshot.',
    nodeIds: nodes.map(node => node.id)
  }] : [];
} else {
  throw new Error(`unsupported target acceptance role: ${role}`);
}

await fs.writeFile(outputPath, JSON.stringify(output, null, 2) + '\n');

function nodeType(file) {
  if (file.fileCategory === 'docs') return 'document';
  if (file.fileCategory === 'config') return 'config';
  if (file.fileCategory === 'infra') return file.path.startsWith('.github/workflows/') ? 'pipeline' : 'service';
  if (file.fileCategory === 'data') return 'schema';
  return 'file';
}

function isFileLevel(type) {
  return ['file','config','document','service','pipeline','table','schema','resource','endpoint'].includes(type);
}