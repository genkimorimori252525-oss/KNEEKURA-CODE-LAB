import fs from 'node:fs/promises';
const [,, role, inputPath, outputPath] = process.argv;
if (!role || !inputPath || !outputPath) throw new Error('usage: node ua-native-fixture-role.mjs <role> <input> <output>');
const input = JSON.parse(await fs.readFile(inputPath, 'utf8'));
let output;
if (role === 'project-scanner') {
  output = { name: 'ua-native-fixture', description: 'Understand Anything の固定受け入れ用ミニリポジトリ。', languages: Object.keys(input.scan?.stats?.byLanguage ?? {}).sort(), frameworks: [] };
} else if (role === 'file-analyzer') {
  const nodes = [], edges = [];
  for (const file of input.batchFiles ?? []) nodes.push({ id: `${nodeType(file)}:${file.path}`, type: nodeType(file), name: file.path.split('/').at(-1), filePath: file.path, summary: `${file.path} の役割を固定fixtureから確認したファイルノード。`, tags: ['fixture','acceptance',file.fileCategory], complexity: file.sizeLines > 50 ? 'moderate' : 'simple' });
  for (const file of input.batchFiles ?? []) if (file.fileCategory === 'code') for (const target of input.batchImportData?.[file.path] ?? []) edges.push({ source: `file:${file.path}`, target: `file:${target}`, type: 'imports', direction: 'forward', weight: 0.7 });
  output = { nodes, edges };
} else if (role === 'assemble-reviewer') output = { issues: [], warnings: [] };
else if (role === 'architecture-analyzer') { const fileNodes = (input.nodes ?? []).filter(node => ['file','config','document','service','pipeline','table','schema','resource','endpoint'].includes(node.type)); output = [{ id: 'layer:fixture', name: 'Fixture', description: '固定fixtureの全ファイル。', nodeIds: fileNodes.map(node => node.id) }]; }
else if (role === 'tour-builder') { const first = (input.nodes ?? []).find(node => ['file','config','document','service','pipeline','table','schema','resource','endpoint'].includes(node.type)); output = first ? [{ order: 1, title: 'Fixture overview', description: '固定fixtureの入口を確認する。', nodeIds: [first.id] }] : []; }
else throw new Error(`unsupported fixture role: ${role}`);
await fs.writeFile(outputPath, JSON.stringify(output, null, 2) + '\n');
function nodeType(file) { if (file.fileCategory === 'docs') return 'document'; if (file.fileCategory === 'config') return 'config'; if (file.fileCategory === 'infra') return file.path.startsWith('.github/workflows/') ? 'pipeline' : 'service'; if (file.fileCategory === 'data') return 'schema'; return 'file'; }