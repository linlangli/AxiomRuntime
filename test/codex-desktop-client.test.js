import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';
import { Response } from 'undici';
import { desktopDir, desktopOrigin, desktopSecret, registerDesktopGateway } from '../dist/core/integrations/codex-desktop.js';
import { writeProviders } from '../dist/core/config/providers-store.js';
import { desktopHandler } from '../dist/server/codex-desktop.js';

const binary = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';

test('bundled desktop backend discovers the relay and switches official → relay → official over verified TLS', { skip: !existsSync(binary) }, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'axiom-desktop-client-'));
  const originalEnv = { ...process.env };
  const config = path.join(home, '.codex');
  process.env.CODEX_HOME = config;
  process.env.AI_GATEWAY_HOME = path.join(home, 'runtime');
  const env = { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: home, CODEX_HOME: config,
    AI_GATEWAY_HOME: process.env.AI_GATEWAY_HOME, HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', NO_PROXY: '127.0.0.1,localhost' };
  let server, child, timer;
  try {
    const tls = spawnSync('bash', ['scripts/setup-codex-desktop-tls.command'], { env, input: 'no\n', encoding: 'utf8' });
    assert.equal(tls.status, 1, 'must decline actual keychain changes');
    const cert = path.join(desktopDir(), 'localhost.pem');
    const secret = await desktopSecret();
    const models = [{ slug: 'gpt-unit', display_name: 'Official', description: 'Test', base_instructions: 'Help with coding.', shell_type: 'shell_command', supported_reasoning_levels: [], visibility: 'list', supported_in_api: true, priority: 0, support_verbosity: false, truncation_policy: { mode: 'tokens', limit: 10000 }, experimental_supported_tools: [] }];
    const turns = [];
    const handler = desktopHandler(secret, async (url, options) => {
      if (String(url).includes('/models')) return Response.json({ models });
      const body = JSON.parse(options.body);
      const message = turns.length === 1 ? { id: 'fc_1', type: 'function_call', name: 'axiom_probe', arguments: '{}', call_id: 'call_test' } :
        { id: 'msg_' + turns.length, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ack-' + turns.length }] };
      turns.push({ url: String(url), headers: options.headers, body });
      const id = 'resp_' + turns.length;
      const events = [{ type: 'response.created', response: { id } }, { type: 'response.output_item.done', output_index: 0, item: message }, { type: 'response.completed', response: { id, output: [message] } }];
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    });
    server = https.createServer({ cert: await fs.readFile(cert), key: await fs.readFile(path.join(desktopDir(), 'localhost-key.pem')) }, (req, res) => {
      req.headers.host = new URL(desktopOrigin).host;
      return handler(req, res);
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    await fs.mkdir(config); const file = path.join(config, 'config.toml');
    await fs.writeFile(file, 'model_provider="axiom-desktop"\nmodel="gpt-unit"\ncli_auth_credentials_store="file"\n');
    await registerDesktopGateway(secret);
    await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replaceAll(desktopOrigin, `https://127.0.0.1:${server.address().port}`));
    await writeProviders([{ name: 'Relay', model: 'vendor-text', level: 0, mode: 'auto', baseUrl: 'https://relay.invalid/v1', apiKey: 'relay-key', codexDesktop: true,
      requestProfile: { discoveryAuth: 'bearer', openaiAuth: 'bearer', anthropicAuth: 'x-api-key', verifiedProtocols: ['openai'] } }]);
    await fs.writeFile(path.join(config, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'test-only-api-key' }));
    child = spawn(binary, ['app-server'], { cwd: home, stdio: ['pipe', 'pipe', 'ignore'], env: { ...env, CODEX_CA_CERTIFICATE: cert } });
    timer = setTimeout(() => child.kill('SIGKILL'), 25000);
    const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const until = async predicate => { for (;;) { const { value, done } = await lines.next(); assert.ok(!done, 'app-server closed'); const msg = JSON.parse(value); if (predicate(msg)) return msg; } };
    let seq = 0;
    const rpc = async (method, params) => { child.stdin.write(JSON.stringify({ id: ++seq, method, params }) + '\n'); const reply = await until(msg => msg.id === seq); assert.ok(!reply.error, JSON.stringify(reply.error)); return reply.result; };
    await rpc('initialize', { clientInfo: { name: 'axiom_test', version: '1' }, capabilities: { experimentalApi: true } });
    child.stdin.write('{"method":"initialized"}\n');
    const list = await rpc('model/list', {});
    const alias = list.data.find(model => model.displayName === 'Relay · vendor-text')?.model;
    assert.ok(alias, 'relay absent from model/list: ' + list.data.map(model => model.displayName).join(', '));
    const { thread } = await rpc('thread/start', { cwd: home, ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never',
      dynamicTools: [{ name: 'axiom_probe', description: 'Read an isolated fixture', inputSchema: { type: 'object', properties: {} } }] });
    const fixture = path.join(home, 'probe'); await fs.writeFile(fixture, 'read-only-tool-output');
    for (const model of ['gpt-unit', alias, 'gpt-unit']) {
      await rpc('turn/start', { threadId: thread.id, model, input: [{ type: 'text', text: 'isolated-marker' }] });
      if (model === alias) {
        const call = await until(msg => msg.method === 'item/tool/call' || msg.method === 'turn/completed');
        assert.equal(call.params.tool, 'axiom_probe');
        child.stdin.write(JSON.stringify({ id: call.id, result: { success: true, contentItems: [{ type: 'inputText', text: await fs.readFile(fixture, 'utf8') }] } }) + '\n');
      }
      const done = await until(msg => msg.method === 'turn/completed' && msg.params.threadId === thread.id);
      assert.equal(done.params.turn.status, 'completed', JSON.stringify(done.params.turn.error));
    }
    assert.deepEqual(turns.map(turn => new URL(turn.url).host), ['chatgpt.com', 'relay.invalid', 'relay.invalid', 'chatgpt.com']);
    assert.equal(turns[1].headers.Authorization, 'Bearer relay-key');
    assert.equal(turns[1].body.model, 'vendor-text');
    assert.match(JSON.stringify(turns[3].body.input), /ack-2/);
    assert.match(JSON.stringify(turns[3].body.input), /read-only-tool-output/);
  } finally {
    clearTimeout(timer);
    if (child && child.exitCode === null && child.signalCode === null) { const closed = once(child, 'close'); child.kill('SIGKILL'); await closed; }
    if (server?.listening) { const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed; }
    for (const key of ['CODEX_HOME', 'AI_GATEWAY_HOME']) { if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key]; }
    await fs.rm(home, { recursive: true, force: true });
  }
});
