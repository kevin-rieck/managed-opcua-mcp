import type { NativeDataType, NativeNodeId, NativeScalar } from './native-encoding.js';
import type { StatusCode } from './status-code.js';

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
  statusCode?: StatusCode;
  sourceTimestamp?: string;
  serverTimestamp?: string;
}

export type NativeWriteResult =
  | { kind: 'operation'; statusCode?: StatusCode }
  | { kind: 'service_error'; statusCode?: StatusCode };

export interface NodeMetadataResult {
  exists?: boolean;
  browseable?: boolean;
  readable?: boolean;
  writable?: boolean;
  dataType?: string;
  valueRank?: number;
  attributeStatuses?: {
    browse?: string;
    nodeId?: string;
    dataType?: string;
    valueRank?: string;
    userAccessLevel?: string;
  };
  attributeStatusCodes?: {
    browse?: StatusCode;
    nodeId?: StatusCode;
    dataType?: StatusCode;
    valueRank?: StatusCode;
    userAccessLevel?: StatusCode;
  };
}

export interface OpcUaGateway {
  status(): Promise<OpcUaStatus>;
  connect(): Promise<void>;
  close(): Promise<void>;
  browse(nodeId: string, depth: number): Promise<BrowseNodeResult[]>;
  read(nodeId: string): Promise<ReadValueResult>;
  readMany(nodeIds: string[]): Promise<ReadValueResult[]>;
  writeNative(
    nodeId: NativeNodeId,
    dataType: NativeDataType,
    value: NativeScalar,
  ): Promise<NativeWriteResult>;
  getNodeMetadata?(nodeId: string): Promise<NodeMetadataResult>;
}
