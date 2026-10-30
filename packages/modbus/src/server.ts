import type { Socket, TCPSocketListener } from 'bun';
import { type Device, DeviceImage } from './map';
import {
  AduDecoder,
  EXCEPTION,
  encodeAdu,
  exceptionPdu,
  FC,
  FramingError,
  parseRequest,
  readResponsePdu,
  writeMultipleResponsePdu,
} from './protocol';

export interface ModbusServerOptions {
  /** TCP port; 0 picks a free one (see the returned `port`). Modbus TCP's registered port is 502. */
  port: number;
  /** Interface to bind; default 127.0.0.1 (local-first, like the rest of wattsim). Pass 0.0.0.0 so a controller on another host can read the meters. */
  host?: string;
  /** Devices by unit id (0..255). */
  devices: Record<number, Device>;
  /**
   * A request for a unit id with no device: `exception` answers 0Bh, Gateway Target Device Failed to Respond
   * (what a Modbus TCP gateway answers for a missing serial device), `ignore` sends nothing and lets the
   * client time out. Default `exception`.
   */
  unknownUnit?: 'exception' | 'ignore';
  /** Called for each request served, for logs and tests. */
  onRequest?: (event: RequestEvent) => void;
}

export interface RequestEvent {
  unitId: number;
  transactionId: number;
  functionCode: number;
  /** Exception code sent back, if any. */
  exception?: number;
}

export interface ModbusServer {
  port: number;
  host: string;
  /** Stops listening and closes every client connection. */
  stop(): void;
  /** Open client connections. */
  readonly connections: number;
}

interface Conn {
  decoder: AduDecoder;
  queue: Uint8Array[];
}

/** Writes queued for one slow client before it is disconnected. */
const MAX_QUEUED_BYTES = 1 << 20;

/**
 * Starts a Modbus TCP server (Bun.listen) that answers for every device in `devices`. Requests on one
 * connection are answered in order, so pipelined requests work; each connection is independent.
 */
export function startModbus(options: ModbusServerOptions): ModbusServer {
  const images = new Map<number, DeviceImage>();
  for (const [key, device] of Object.entries(options.devices)) {
    const unitId = Number(key);
    if (!Number.isInteger(unitId) || unitId < 0 || unitId > 255) throw new Error(`unit id ${key} outside 0..255`);
    images.set(unitId, new DeviceImage(device, unitId));
  }
  // Modbus Messaging on TCP/IP Implementation Guide v1.0b (MBAP Unit Identifier): a server addressed by its IP
  // address alone is sent unit id 0xFF, and many clients send 0. With a single device, both reach it unless
  // they name a device of their own.
  if (images.size === 1) {
    const only = [...images.values()][0];
    if (only) {
      if (!images.has(0xff)) images.set(0xff, only);
      if (!images.has(0)) images.set(0, only);
    }
  }
  const unknownUnit = options.unknownUnit ?? 'exception';
  const host = options.host ?? '127.0.0.1';
  const sockets = new Set<Socket<Conn>>();

  const send = (socket: Socket<Conn>, bytes: Uint8Array) => {
    const conn = socket.data;
    if (conn.queue.length > 0) {
      conn.queue.push(bytes);
      if (conn.queue.reduce((n, b) => n + b.length, 0) > MAX_QUEUED_BYTES) socket.end();
      return;
    }
    const written = socket.write(bytes);
    if (written >= 0 && written < bytes.length) conn.queue.push(bytes.subarray(written));
  };

  const answer = (unitId: number, pdu: Uint8Array): { pdu: Uint8Array; exception?: number } | undefined => {
    const fc = pdu[0] ?? 0;
    const fail = (code: number) => ({ pdu: exceptionPdu(fc, code), exception: code });
    const image = images.get(unitId);
    if (!image) return unknownUnit === 'ignore' ? undefined : fail(EXCEPTION.GATEWAY_TARGET_FAILED_TO_RESPOND);
    if (!image.map.functions.includes(fc)) return fail(EXCEPTION.ILLEGAL_FUNCTION);
    const parsed = parseRequest(pdu);
    if (!parsed.ok) return fail(parsed.exception);
    const req = parsed.request;
    switch (req.fc) {
      case FC.READ_HOLDING_REGISTERS:
      case FC.READ_INPUT_REGISTERS: {
        const r = image.read(req.fc === FC.READ_INPUT_REGISTERS ? 'input' : 'holding', req.address, req.quantity);
        return r.ok ? { pdu: readResponsePdu(req.fc, r.value) } : fail(r.exception);
      }
      case FC.WRITE_SINGLE_REGISTER: {
        const r = image.write(req.address, [req.value]);
        return r.ok ? { pdu: pdu.slice() } : fail(r.exception);
      }
      case FC.WRITE_MULTIPLE_REGISTERS: {
        const r = image.write(req.address, req.values);
        return r.ok ? { pdu: writeMultipleResponsePdu(req.address, req.values.length) } : fail(r.exception);
      }
    }
  };

  const listener: TCPSocketListener<Conn> = Bun.listen<Conn>({
    hostname: host,
    port: options.port,
    socket: {
      open(socket) {
        socket.data = { decoder: new AduDecoder(), queue: [] };
        sockets.add(socket);
      },
      data(socket, chunk) {
        let adus: ReturnType<AduDecoder['push']>;
        try {
          adus = socket.data.decoder.push(chunk);
        } catch (err) {
          if (err instanceof FramingError) {
            socket.end();
            return;
          }
          throw err;
        }
        for (const adu of adus) {
          // Not Modbus (protocol id ≠ 0): discarded without an answer.
          if (adu.protocolId !== 0) continue;
          const result = answer(adu.unitId, adu.pdu);
          options.onRequest?.({
            unitId: adu.unitId,
            transactionId: adu.transactionId,
            functionCode: adu.pdu[0] ?? 0,
            exception: result?.exception,
          });
          if (!result) continue;
          send(
            socket,
            encodeAdu({ transactionId: adu.transactionId, protocolId: 0, unitId: adu.unitId, pdu: result.pdu }),
          );
        }
      },
      drain(socket) {
        const conn = socket.data;
        while (conn.queue.length > 0) {
          const head = conn.queue[0];
          if (!head) break;
          const written = socket.write(head);
          if (written < 0) {
            conn.queue = [];
            return;
          }
          if (written < head.length) {
            conn.queue[0] = head.subarray(written);
            return;
          }
          conn.queue.shift();
        }
      },
      close(socket) {
        sockets.delete(socket);
      },
      error(socket) {
        sockets.delete(socket);
      },
    },
  });

  return {
    port: listener.port,
    host,
    get connections() {
      return sockets.size;
    },
    stop() {
      listener.stop(true);
      for (const s of sockets) s.end();
      sockets.clear();
    },
  };
}

export interface PerPortOptions {
  /** First port; device n (in unit id order) listens on basePort + n. 0 picks free ports. */
  basePort: number;
  host?: string;
  devices: Record<number, Device>;
  unknownUnit?: ModbusServerOptions['unknownUnit'];
}

export interface PerPortServers {
  servers: { unitId: number; server: ModbusServer }[];
  stop(): void;
}

/**
 * One server per device on consecutive ports, each answering only its own unit id (plus 0 and 255), for
 * controllers that expect one IP:port per meter.
 */
export function startModbusPerPort(options: PerPortOptions): PerPortServers {
  const servers: PerPortServers['servers'] = [];
  const ids = Object.keys(options.devices)
    .map(Number)
    .sort((a, b) => a - b);
  try {
    ids.forEach((unitId, n) => {
      const device = options.devices[unitId];
      if (!device) return;
      const server = startModbus({
        port: options.basePort === 0 ? 0 : options.basePort + n,
        host: options.host,
        devices: { [unitId]: device },
        unknownUnit: options.unknownUnit,
      });
      servers.push({ unitId, server });
    });
  } catch (err) {
    for (const s of servers) s.server.stop();
    throw err;
  }
  return {
    servers,
    stop() {
      for (const s of servers) s.server.stop();
    },
  };
}
