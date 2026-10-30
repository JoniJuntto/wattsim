import type { Socket } from 'bun';

export const hex = (s: string) =>
  Uint8Array.from(s.replace(/\s+/g, '').match(/../g) ?? [], (b) => Number.parseInt(b, 16));
export const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** A raw TCP connection that collects every byte received, for byte-level assertions. */
export interface RawConn {
  write(bytes: Uint8Array): void;
  /** Resolves once at least `n` bytes have arrived (or rejects after `ms`). */
  read(n: number, ms?: number): Promise<Uint8Array>;
  /** Resolves when the server closes the connection. */
  closed: Promise<void>;
  received(): Uint8Array;
  end(): void;
}

export async function raw(port: number): Promise<RawConn> {
  let buf = new Uint8Array(0);
  let waiters: (() => void)[] = [];
  let onClose: () => void = () => {};
  const closed = new Promise<void>((r) => {
    onClose = r;
  });
  const socket: Socket<undefined> = await Bun.connect({
    hostname: '127.0.0.1',
    port,
    socket: {
      data(_s, chunk) {
        const merged = new Uint8Array(buf.length + chunk.length);
        merged.set(buf);
        merged.set(chunk, buf.length);
        buf = merged;
        const w = waiters;
        waiters = [];
        for (const f of w) f();
      },
      close() {
        onClose();
      },
      end() {
        onClose();
      },
    },
  });
  return {
    write: (bytes) => {
      socket.write(bytes);
      socket.flush();
    },
    async read(n, ms = 1000) {
      const deadline = Date.now() + ms;
      while (buf.length < n) {
        if (Date.now() > deadline) throw new Error(`timeout: ${buf.length}/${n} bytes`);
        await new Promise<void>((r) => {
          waiters.push(r);
          setTimeout(r, 20);
        });
      }
      const out = buf.slice(0, n);
      buf = buf.slice(n);
      return out;
    },
    closed,
    received: () => buf,
    end: () => socket.end(),
  };
}

export const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
