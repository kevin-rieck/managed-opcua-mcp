import type { BrowseNodeResult, OpcUaGateway, OpcUaStatus, ReadValueResult, WriteValueResult } from './gateway.js';

export class NodeOpcUaGateway implements OpcUaGateway {
  status(): Promise<OpcUaStatus> {
    return Promise.resolve({ state: 'disconnected', connectionGeneration: 0 });
  }

  connect(): Promise<void> {
    return Promise.reject(new Error('OPC UA gateway is not implemented yet.'));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  browse(nodeId: string, depth: number): Promise<BrowseNodeResult[]> {
    void nodeId;
    void depth;
    return Promise.reject(new Error('OPC UA browse is not implemented yet.'));
  }

  read(nodeId: string): Promise<ReadValueResult> {
    void nodeId;
    return Promise.reject(new Error('OPC UA read is not implemented yet.'));
  }

  async readMany(nodeIds: string[]): Promise<ReadValueResult[]> {
    return Promise.all(nodeIds.map((nodeId) => this.read(nodeId)));
  }

  write(nodeId: string, dataType: string, value: unknown): Promise<WriteValueResult> {
    void nodeId;
    void dataType;
    void value;
    return Promise.reject(new Error('OPC UA write is not implemented yet.'));
  }
}
