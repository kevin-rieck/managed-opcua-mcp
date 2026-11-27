import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

describe('stdio SDK diagnostics', () => {
  it('keeps SDK diagnostics out of protocol frames and redacts them on stderr', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opcua-stdio-'));
    const config = join(dir, 'config.json');
    // The path is inside this test's temporary directory.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await writeFile(
      config,
      JSON.stringify({
        version: 2,
        connection: {
          endpointUrl: 'opc.tcp://127.0.0.1:1',
          securityMode: 'None',
          securityPolicy: 'None',
          auth: { type: 'anonymous' },
        },
        audit: { file: join(dir, 'audit.jsonl') },
      }),
    );
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'tests/integration/stdio-diagnostics-fixture.ts', config],
      {
        env: {
          ...process.env,
          HOME: dir,
          USERPROFILE: dir,
          APPDATA: dir,
          LOCALAPPDATA: dir,
          XDG_CONFIG_HOME: dir,
          XDG_DATA_HOME: dir,
          XDG_CACHE_HOME: dir,
          NODEOPCUAPKIDEBUG: '1',
          VERBOSE: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const exited = new Promise<void>((resolve) => {
      child.once('close', () => resolve());
      child.once('error', () => resolve());
    });
    child.stdin.on('error', () => undefined);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    try {
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })}\n`,
      );
      await vi.waitFor(() => expect(stdout).toContain('"id":1'), { timeout: 30_000 });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
      );
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
      let nextId = 3;
      const frames = () =>
        stdout
          .split('\n')
          .slice(0, -1)
          .map(
            (line) =>
              JSON.parse(line) as {
                jsonrpc: string;
                id?: number;
                result?: { tools?: { name: string }[]; contents?: { text: string }[] };
              },
          );
      await vi.waitFor(
        async () => {
          const id = nextId++;
          child.stdin.write(
            `${JSON.stringify({ jsonrpc: '2.0', id, method: 'resources/read', params: { uri: 'opcua://status' } })}\n`,
          );
          let text: string | undefined;
          await vi.waitFor(
            () => {
              text = frames().find((frame) => frame.id === id)?.result?.contents?.[0]?.text;
              expect(text).toBeDefined();
            },
            { timeout: 10_000 },
          );
          expect(JSON.parse(text ?? '{}')).toMatchObject({
            connection: { state: 'disconnected', lastError: { code: 'opcua_connection_failed' } },
          });
        },
        { timeout: 30_000, interval: 200 },
      );
      await vi.waitFor(
        () => {
          expect(stderr.split('OPC UA process diagnostic.').length - 1).toBeGreaterThanOrEqual(7);
        },
        { timeout: 30_000 },
      );
      const received = frames();
      expect(received.map((frame) => frame.id)).toEqual(
        Array.from({ length: nextId - 1 }, (_, index) => index + 1),
      );
      expect(received.every((frame) => frame.jsonrpc === '2.0')).toBe(true);
      expect(received[1]?.result?.tools?.map((tool) => tool.name)).toContain('write_node');
      expect(stdout + stderr).not.toMatch(/secret-value|secret-node|secret-password/);
      const diagnostics = stderr.split('\n').filter(Boolean);
      const allowed = [
        'OPC UA SDK debug diagnostic.',
        'OPC UA SDK warning diagnostic.',
        'OPC UA SDK error diagnostic.',
        'OPC UA SDK trace diagnostic.',
        'OPC UA process diagnostic.',
      ];
      expect(diagnostics).toEqual(expect.arrayContaining(allowed));
      expect(diagnostics.every((line) => allowed.includes(line))).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
