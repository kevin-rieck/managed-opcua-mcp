import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCliProgram } from '../../src/cli/index.js';
import { loadConfigFile } from '../../src/config/load-config.js';
import { appConfigSchema } from '../../src/config/schema.js';

const dirs: string[] = [];
const v1 = `version: 1
connection:
  endpointUrl: \${MIGRATION_TEST_MISSING_ENDPOINT}
  securityMode: None
  securityPolicy: None
  auth: { type: anonymous }
audit: { file: ./audit.jsonl }
`;
async function tempConfig(source: string) {
  const dir = await mkdtemp(join(tmpdir(), 'opcua-v2-'));
  dirs.push(dir);
  const path = join(dir, 'source.yaml');
  // Test-owned temporary file.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await writeFile(path, source);
  return path;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('v2 configuration cutover', () => {
  it.each([
    '',
    'controls: { enabled: false, items: [] }\n',
    'controls: { enabled: true, items: [] }\n',
    'controls: { items: [{ name: x }] }\n',
  ])(
    'rejects every v1 variant before environment resolution and never rewrites %#',
    async (controls) => {
      const source = v1 + controls;
      const path = await tempConfig(source);
      await expect(loadConfigFile(path)).rejects.toThrow(
        'Configuration version 1 is unsupported; manually create a version 2 config after reviewing OPC UA account write permissions and removing controls.',
      );
      // Test-owned temporary file.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      expect(await readFile(path, 'utf8')).toBe(source);
    },
  );
  it.each(['doctor', 'validate-config', 'serve'])(
    'rejects v1 before creating a gateway for %s',
    async (command) => {
      const path = await tempConfig(v1);
      const gatewayFactory = vi.fn(() => {
        throw new Error('gateway must not be created');
      });
      let output = '';
      const program = createCliProgram({
        gatewayFactory,
        stdout: (text) => {
          output += text;
        },
        stderr: vi.fn(),
        setExitCode: vi.fn(),
      });
      const args = [
        'node',
        'opcua-mcp',
        command,
        '--config',
        path,
        ...(command === 'validate-config' ? ['--online'] : []),
      ];
      if (command === 'serve')
        await expect(program.parseAsync(args)).rejects.toThrow(
          'Configuration version 1 is unsupported',
        );
      else {
        await program.parseAsync(args);
        expect(output).toContain('Configuration version 1 is unsupported');
      }
      expect(gatewayFactory).not.toHaveBeenCalled();
    },
  );
  it.each(['setup', 'discover-controls'])(
    'does not register retired command %s',
    async (command) => {
      const program = createCliProgram({ setExitCode: vi.fn() });
      expect(program.commands.map((item) => item.name())).not.toContain(command);
      await expect(program.parseAsync(['node', 'opcua-mcp', command])).rejects.toMatchObject({
        code: 'commander.unknownCommand',
      });
    },
  );
  it('rejects unknown v2 fields, removed controls and duplicate root labels', () => {
    const base = {
      version: 2,
      connection: {
        endpointUrl: 'opc.tcp://localhost:4840',
        securityMode: 'None',
        securityPolicy: 'None',
        auth: { type: 'anonymous' },
      },
      audit: { file: './audit.jsonl' },
    };
    expect(appConfigSchema.safeParse(base).success).toBe(true);
    expect(appConfigSchema.safeParse({ ...base, controls: {} }).success).toBe(false);
    expect(appConfigSchema.safeParse({ ...base, extra: true }).success).toBe(false);
    expect(
      appConfigSchema.safeParse({
        ...base,
        read: {
          roots: [
            { nodeId: 'i=1', label: 'same' },
            { nodeId: 'i=2', label: 'same' },
          ],
        },
      }).success,
    ).toBe(false);
  });
});
