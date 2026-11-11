/**
 * Settle pools — the replay matching substrate of the journal kernel.
 *
 * On resume, journal rows are pooled per site in the store's PHYSICAL SETTLEMENT
 * order (`getDwfNodes` reads them `ORDER BY completed_at ASC` — deliberately not
 * the launch-time ordinal) and consumed 1:1 by `inputHash` content matching.
 * Identical-input fan-out siblings settle back in first-settlement order, and
 * different inputs can never misbind onto a sibling's row: order alone would
 * bind by position, content alone would lose the release order — the gate needs
 * both (ZCODE-DEEP-REVERSE-v2 §1.1; ARCHITECTURE.md kernel #3).
 */
import { createHash } from 'node:crypto';
import type { DwfNode } from '../types.js';

/**
 * NUL-separated hash template: every journal key hashes the raw tuple
 * `${kind}\u0000${siteId}\u0000${input}` (hole/escalation variants included).
 * The head fields are engine-controlled — `kind` is a closed enum, site ids are
 * compiler-generated — so the first two NUL bytes are always the true
 * separators, and a NUL inside the tail input cannot fake a field boundary. NUL
 * beats any printable delimiter because `JSON.stringify` never emits a raw
 * 0x00 (it escapes to `\u0000`), keeping the concatenation injective by
 * construction rather than by field-content discipline.
 */
export function journalInputHash(kind: string, siteId: string, input: string): string {
  return createHash('sha256').update(`${kind}\u0000${siteId}\u0000${input}`).digest('hex');
}

export function poolKey(siteId: string, ordinal: number): string {
  return `${siteId}#${ordinal}`;
}

/** Per-site journal rows available for replay, consumed 1:1 by content match. */
export class SettlePools {
  private readonly journalPools = new Map<string, Map<string, DwfNode>>();
  private readonly importedPools = new Map<string, Map<string, DwfNode>>();
  private readonly consumed = new Set<string>();

  constructor(private readonly importedCache?: Map<string, DwfNode>) {}

  /**
   * Rows the CURRENT run already journalled for this site, keyed
   * `siteId#ordinal` in physical settlement order. Lazily built once per site.
   */
  async journalPool(siteId: string, loadRows: (() => Promise<DwfNode[]>) | undefined): Promise<Map<string, DwfNode>> {
    let pool = this.journalPools.get(siteId);
    if (!pool) {
      pool = new Map();
      if (loadRows) {
        for (const n of await loadRows()) {
          if (n.siteId === siteId) pool.set(poolKey(n.siteId, n.ordinal), n);
        }
      }
      this.journalPools.set(siteId, pool);
    }
    return pool;
  }

  /** Already-built journal pool for this site, if any (live ordinal allocation scans it). */
  peekJournalPool(siteId: string): Map<string, DwfNode> | undefined {
    return this.journalPools.get(siteId);
  }

  /** Warm-cache rows imported from the prior-run lineage (amend), same keying. */
  importedPool(siteId: string): Map<string, DwfNode> {
    let pool = this.importedPools.get(siteId);
    if (!pool) {
      pool = new Map();
      if (this.importedCache) {
        for (const n of this.importedCache.values()) {
          if (n.siteId === siteId) pool.set(poolKey(n.siteId, n.ordinal), n);
        }
      }
      this.importedPools.set(siteId, pool);
    }
    return pool;
  }

  /** Take the first unconsumed pool row of this kind whose input hash matches. */
  take(pool: Map<string, DwfNode>, kind: string, inputHash: string): DwfNode | undefined {
    for (const [key, n] of pool) {
      if (this.consumed.has(key)) continue;
      if (n.kind !== kind) continue;
      if (n.inputHash === inputHash) {
        this.consumed.add(key);
        return n;
      }
    }
    return undefined;
  }

  rowAt(pool: Map<string, DwfNode>, siteId: string, ordinal: number): DwfNode | undefined {
    return pool.get(poolKey(siteId, ordinal));
  }

  isConsumed(siteId: string, ordinal: number): boolean {
    return this.consumed.has(poolKey(siteId, ordinal));
  }
}
