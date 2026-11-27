import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { it } from 'vitest';

it('releases internally owned installed managers on repeated failed connects', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opcua-pki-cleanup-'));
  try {
    await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', 'tests/opcua/pki-cleanup-fixture.ts', dir],
      {
        timeout: 60_000,
        env: {
          ...process.env,
          HOME: dir,
          USERPROFILE: dir,
          APPDATA: dir,
          LOCALAPPDATA: dir,
          XDG_CONFIG_HOME: dir,
          XDG_DATA_HOME: dir,
          XDG_CACHE_HOME: dir,
        },
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 70_000);
