/**
 * Recorder: collects `TraceEntry`s from core Stations (their `frame` events) or from the proxy, keeps them in memory
 * and optionally appends them to a trace file as they arrive.
 */
import type { Clock, Station } from '@wattsim/core';
import type { TraceEntry } from './entry';
import { makeEntry } from './entry';
import type { TraceFileFormat } from './write';
import { TraceWriter } from './write';

export type RecorderOptions = {
  /** Append every entry to this file as it is recorded. */
  path?: string;
  /** File format, default `oot` (Open OCPP Trace v1.1). */
  format?: TraceFileFormat;
  /** Timestamps for stations attached without their own clock override; default each station's clock. */
  clock?: Clock;
  /** Keep entries in `entries`; default true. Turn off for long proxy sessions that only need the file. */
  keep?: boolean;
  /** Called for an entry the file format cannot represent; it stays in `entries` but is not written. */
  onSkip?: (e: TraceEntry) => void;
};

export class Recorder {
  readonly entries: TraceEntry[] = [];
  /** Entries the file format could not represent, so they are missing from the file. */
  skipped = 0;
  private readonly writer: TraceWriter | undefined;
  private readonly keep: boolean;
  private closed = false;

  constructor(private readonly opts: RecorderOptions = {}) {
    this.writer = opts.path ? new TraceWriter(opts.path, opts.format) : undefined;
    this.keep = opts.keep ?? true;
  }

  /**
   * Record every frame that crosses the station's socket, as sent or received. Returns the detach function.
   * Timestamps come from `opts.clock`, else the station's clock. Inbound text that does not decode never reaches a
   * Station's `frame` event, so it is not recorded here (the proxy records it).
   */
  attach(station: Station): () => void {
    const clock = this.opts.clock ?? station.clock;
    return station.on('frame', (dir, _frame, raw) => {
      this.record(makeEntry({ ts: clock.now(), dir, identity: station.id, version: station.version, raw }));
    });
  }

  record(e: TraceEntry): void {
    if (this.keep) this.entries.push(e);
    if (this.writer && !this.closed && !this.writer.write(e)) {
      this.skipped++;
      this.opts.onSkip?.(e);
    }
  }

  /** Flush and close the file, if any. Entries recorded afterwards are kept in memory only. */
  async close(): Promise<void> {
    this.closed = true;
    await this.writer?.close();
  }
}
