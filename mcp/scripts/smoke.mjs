import assert from 'node:assert/strict';

import { createKneekuraCodeLabMcpAdapter } from '../src/adapter.mjs';
import { createKneekuraCodeLabMcpServer } from '../src/server.mjs';

const adapter = createKneekuraCodeLabMcpAdapter();
const description = adapter.describe();
assert.equal(description.name, 'KNEEKURA Code LAB');
assert.equal(description.backend_attached, false);
assert.equal(description.hidden_default_engine, false);

const server = createKneekuraCodeLabMcpServer({ adapter });
assert.ok(server);
process.stdout.write('KNEEKURA Code LAB MCP SDK smoke: PASS\n');