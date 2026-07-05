import { mkdir, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AuditAppendResult, AuditHealth, AuditRecord, AuditSink } from './audit-sink.js';

export class JsonlAuditSink implements AuditSink {
  constructor(private readonly filePath: string) {}

  async health(): Promise<AuditHealth> {
    try {
      // Configured audit path is operator-controlled and validated before use.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      await mkdir(dirname(this.filePath), { recursive: true });
      return { healthy: true };
    } catch (error) {
      return { healthy: false, reason: error instanceof Error ? error.message : 'unknown error' };
    }
  }

  async append(record: AuditRecord): Promise<AuditAppendResult> {
    // Configured audit path is operator-controlled and validated before use.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await mkdir(dirname(this.filePath), { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await appendFile(this.filePath, `${JSON.stringify(record)}\n`, { encoding: 'utf8' });
    return { id: record.id };
  }
}
