/**
 * Backward-compatibility surface for the pure contract types.
 *
 * The canonical definitions now live in the dependency-free domain layer
 * (`src/domain/`): event vocabulary in `domain/events.js`, the evidence ledger
 * in `domain/evidence.js`, all other workflow contracts in
 * `domain/workflow-types.js`. This module re-exports them so every existing
 * `from '../types.js'` import keeps working unchanged.
 */
export * from './domain/events.js';
export * from './domain/evidence.js';
export * from './domain/workflow-types.js';
