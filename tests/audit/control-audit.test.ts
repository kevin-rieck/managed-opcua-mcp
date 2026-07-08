import { describe, expect, it } from 'vitest';
import type { AuditRecord, AuditSink } from '../../src/audit/audit-sink.js';
import { appendControlAuditRecord, requireHealthyAudit } from '../../src/audit/control-audit.js';

describe('Control Attempt audit records', () => {
  it('allows Control Attempts when audit health is available', async () => {
    const auditSink: AuditSink = {
      health: () => Promise.resolve({ healthy: true }),
      append: (record) => Promise.resolve({ id: record.id }),
    };

    await expect(requireHealthyAudit(auditSink)).resolves.toEqual({ ok: true });
  });

  it('size-limits agent-provided reasons before writing audit records', async () => {
    const written: AuditRecord[] = [];
    const auditSink: AuditSink = {
      health: () => Promise.resolve({ healthy: true }),
      append: (record) => {
        written.push(record);
        return Promise.resolve({ id: record.id });
      },
    };

    await appendControlAuditRecord(auditSink, {
      maxReasonLength: 5,
      record: {
        event: 'control.write.requested',
        result: 'accepted',
        controlName: 'motor_enabled',
        nodeId: 'ns=2;s=Machine.MotorEnabled',
        requestedValue: 'enabled',
        rawRequestedValue: true,
        riskLevel: 'low',
        configHash: 'abc123',
        reason: '1234567890',
      },
    });

    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ reason: '12345' });
  });

  it('rejects Control Attempts when audit health is unavailable', async () => {
    const auditSink: AuditSink = {
      health: () => Promise.resolve({ healthy: false, reason: 'disk full' }),
      append: (record) => Promise.resolve({ id: record.id }),
    };

    await expect(requireHealthyAudit(auditSink)).resolves.toEqual({
      ok: false,
      code: 'audit_unavailable',
      message: 'Audit logging is unavailable: disk full',
    });
  });

  it('fails closed when audit health cannot be checked', async () => {
    const auditSink: AuditSink = {
      health: () => Promise.reject(new Error('permission denied\nstack details')),
      append: (record) => Promise.resolve({ id: record.id }),
    };

    await expect(requireHealthyAudit(auditSink)).resolves.toEqual({
      ok: false,
      code: 'audit_unavailable',
      message: 'Audit logging is unavailable: permission denied',
    });
  });
});
