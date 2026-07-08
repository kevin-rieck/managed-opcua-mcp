import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonlAuditSink } from '../../src/audit/jsonl-audit-sink.js';

const tempDirs: string[] = [];

describe('JsonlAuditSink', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('appends one valid JSON audit record per line', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opcua-mcp-audit-'));
    tempDirs.push(dir);
    const filePath = join(dir, 'nested', 'audit.jsonl');
    const sink = new JsonlAuditSink(filePath);

    await sink.append({
      id: 'audit-1',
      timestamp: '2026-07-07T18:00:00.000Z',
      event: 'control.prepare',
      result: 'accepted',
      controlName: 'motor_enabled',
      nodeId: 'ns=2;s=Machine.MotorEnabled',
      requestedValue: 'enabled',
      rawRequestedValue: true,
      riskLevel: 'low',
      callerIdentity: 'agent-a',
      configHash: 'abc123',
      opcuaStatus: 'Good',
      reason: 'start test run',
    });
    await sink.append({
      id: 'audit-2',
      timestamp: '2026-07-07T18:00:01.000Z',
      event: 'control.write',
      result: 'rejected',
      controlName: 'motor_enabled',
      nodeId: 'ns=2;s=Machine.MotorEnabled',
      requestedValue: 'enabled',
      rawRequestedValue: true,
      riskLevel: 'low',
      configHash: 'abc123',
      errorMessage: 'Audit unavailable',
    });

    // Test-controlled temporary path.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const lines = (await readFile(filePath, 'utf8')).trimEnd().split('\n');

    expect(lines).toHaveLength(2);
    expect(
      lines.map((line) => {
        const parsed: unknown = JSON.parse(line);
        return parsed;
      }),
    ).toEqual([
      {
        id: 'audit-1',
        timestamp: '2026-07-07T18:00:00.000Z',
        event: 'control.prepare',
        result: 'accepted',
        controlName: 'motor_enabled',
        nodeId: 'ns=2;s=Machine.MotorEnabled',
        requestedValue: 'enabled',
        rawRequestedValue: true,
        riskLevel: 'low',
        callerIdentity: 'agent-a',
        configHash: 'abc123',
        opcuaStatus: 'Good',
        reason: 'start test run',
      },
      {
        id: 'audit-2',
        timestamp: '2026-07-07T18:00:01.000Z',
        event: 'control.write',
        result: 'rejected',
        controlName: 'motor_enabled',
        nodeId: 'ns=2;s=Machine.MotorEnabled',
        requestedValue: 'enabled',
        rawRequestedValue: true,
        riskLevel: 'low',
        configHash: 'abc123',
        errorMessage: 'Audit unavailable',
      },
    ]);
  });
});
