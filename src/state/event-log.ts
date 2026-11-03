import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { WorkflowEvent } from '../types.js';

export interface EventLogOptions {
  runDir: string;
  flushSync?: boolean;
}

export class EventLogWriter {
  private filePath: string;
  private sequence = 0;
  private fd: number | null = null;
  private flushSync: boolean;

  constructor(runDirOrFile: string, flushSync = true) {
    if (runDirOrFile.endsWith('.jsonl')) {
      this.filePath = runDirOrFile;
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
    } else {
      fs.mkdirSync(runDirOrFile, { recursive: true });
      this.filePath = path.join(runDirOrFile, 'events.jsonl');
    }
    this.flushSync = flushSync;
    this.initSequence();
  }

  private initSequence(): void {
    if (!fs.existsSync(this.filePath)) {
      this.sequence = 0;
      return;
    }
    try {
      const content = fs.readFileSync(this.filePath, 'utf-8');
      if (content.length > 0 && !content.endsWith('\n')) {
        fs.appendFileSync(this.filePath, '\n', { encoding: 'utf-8' });
      }
      const lines = content.trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]?.trim();
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          if (typeof parsed.sequence === 'number') {
            this.sequence = parsed.sequence;
            return;
          }
        } catch {
          continue;
        }
      }
    } catch {
      this.sequence = 0;
    }
  }

  public record(
    eventData: Omit<WorkflowEvent, 'id' | 'sequence' | 'timestamp'> & { id?: string; timestamp?: string }
  ): WorkflowEvent {
    this.sequence += 1;
    const id = eventData.id ?? `evt-${eventData.runId}-${String(this.sequence).padStart(6, '0')}`;
    const event: any = {
      id,
      eventId: id,
      sequence: this.sequence,
      timestamp: eventData.timestamp ?? new Date().toISOString(),
      ...eventData,
    };

    this.writeLine(JSON.stringify(event) + '\n');
    return event;
  }

  /**
   * Append a fully-formed event verbatim — the dual-write entry point for hosts
   * that already assign canonical ids/sequences (e.g. the dwf runner mirrors its
   * SQLite event stream into `events.jsonl`). Unlike {@link record}, nothing is
   * re-numbered: the line on disk is byte-identical to the event persisted in
   * SQLite, so both stores stay directly comparable. The writer's internal
   * sequence tracks the appended event so a later mixed use of {@link record}
   * keeps increasing.
   *
   * @param event - The event to append as-is (must carry `id` and `sequence`).
   */
  public appendEvent(event: WorkflowEvent): void {
    this.sequence = Math.max(this.sequence, event.sequence ?? 0);
    this.writeLine(JSON.stringify(event) + '\n');
  }

  /** Shared append path for {@link record} and {@link appendEvent}. */
  private writeLine(serialized: string): void {
    if (this.flushSync) {
      fs.appendFileSync(this.filePath, serialized, { encoding: 'utf-8' });
    } else {
      if (this.fd === null) {
        this.fd = fs.openSync(this.filePath, 'a');
      }
      fs.writeSync(this.fd, serialized);
    }
  }

  public close(): void {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }
}

export class EventLogReader {
  public static async readAll(filePath: string): Promise<WorkflowEvent[]> {
    if (!fs.existsSync(filePath)) {
      return [];
    }

    const events: WorkflowEvent[] = [];
    const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed) as WorkflowEvent;
        events.push(event);
      } catch {
        // Corrupted or incomplete line (e.g. from crash) dropped with graceful tolerance
      }
    }

    return events;
  }

  public static async *streamEvents(filePath: string): AsyncGenerator<WorkflowEvent> {
    if (!fs.existsSync(filePath)) return;
    const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        yield JSON.parse(trimmed) as WorkflowEvent;
      } catch {
        continue;
      }
    }
  }
}
