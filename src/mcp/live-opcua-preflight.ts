import type { OpcUaGateway, OpcUaStatus } from '../opcua/gateway.js';

export interface ConnectedOpcUaPreflight {
  ok: true;
  connection: OpcUaStatus;
}

export interface NotConnectedOpcUaPreflight {
  ok: false;
  response: {
    ok: false;
    code: 'opcua_not_connected';
    message: string;
    connection: OpcUaStatus;
  };
}

export type OpcUaPreflight = ConnectedOpcUaPreflight | NotConnectedOpcUaPreflight;

export async function requireConnectedOpcUa(gateway: OpcUaGateway): Promise<OpcUaPreflight> {
  const connection = await gateway.status();
  if (connection.state === 'connected') return { ok: true, connection };

  return {
    ok: false,
    response: {
      ok: false,
      code: 'opcua_not_connected',
      message: 'OPC UA Server is not connected yet.',
      connection,
    },
  };
}
