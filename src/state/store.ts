import { StateStore } from '../types.js';
import { SQLiteStateStore } from './sqlite-store.js';
import { EventLogWriter, EventLogReader } from './event-log.js';

export { StateStore } from '../types.js';
export { SQLiteStateStore } from './sqlite-store.js';
export { EventLogWriter, EventLogReader } from './event-log.js';
export { ReplayEngine } from './replay.js';

export function createSQLiteStore(dbPath?: string): SQLiteStateStore {
  return new SQLiteStateStore(dbPath ?? ':memory:');
}
