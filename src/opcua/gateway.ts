export type OpcUaConnectionState = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

export interface OpcUaStatus {
  state: OpcUaConnectionState;
  serverStatus?: string;
  lastSuccessfulHealthCheckAt?: string;
  lastError?: {
    code: string;
    message: string;
    at: string;
  };
  connectionGeneration: number;
}

export interface BrowseNodeResult {
  nodeId: string;
  browseName?: string;
  displayName?: string;
  nodeClass?: string;
  dataType?: string;
  readable?: boolean;
  writable?: boolean;
  callable?: boolean;
}

export interface ReadValueResult {
  nodeId: string;
  dataType?: string;
  value: unknown;
  opcuaStatus?: string;
  sourceTimestamp?: string;
  serverTimestamp?: string;
}

export interface WriteValueResult {
  opcuaStatus: string;
}

export interface NodeMetadataResult {
  exists?: boolean;
  browseable?: boolean;
  readable?: boolean;
  writable?: boolean;
  dataType?: string;
}

export interface OpcUaGateway {
  status(): Promise<OpcUaStatus>;
  connect(): Promise<void>;
  close(): Promise<void>;
  browse(nodeId: string, depth: number): Promise<BrowseNodeResult[]>;
  read(nodeId: string): Promise<ReadValueResult>;
  readMany(nodeIds: string[]): Promise<ReadValueResult[]>;
  write(nodeId: string, dataType: string, value: unknown): Promise<WriteValueResult>;
  getNodeMetadata?(nodeId: string): Promise<NodeMetadataResult>;
}
