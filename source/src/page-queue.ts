export type UnitPriorityTier = 1 | 2 | 3; // 1: in-viewport, 2: near-viewport, 3: offscreen

export interface QueuedUnitLike {
  tier: UnitPriorityTier;
  queued: boolean;
  translation?: string;
  failed?: boolean;
  isConnected(): boolean;
}

// O(1) bucketed priority queue + incremental counter store for 10,000+ segment pages (Q-T18, Q-00).
export class PagePriorityQueue<U extends QueuedUnitLike> {
  private readonly visible = new Set<U>();
  private readonly near = new Set<U>();
  private readonly other = new Set<U>();

  discoveredCount = 0;
  renderedCount = 0;
  failedCount = 0;

  get queuedSize(): number {
    return this.visible.size + this.near.size + this.other.size;
  }

  get activeQueuedSize(): number {
    return this.visible.size + this.near.size;
  }

  enqueue(unit: U, tier: UnitPriorityTier = unit.tier): void {
    this.removeFromBuckets(unit);
    unit.tier = tier;
    unit.queued = true;
    if (tier === 1) this.visible.add(unit);
    else if (tier === 2) this.near.add(unit);
    else this.other.add(unit);
  }

  reprioritize(unit: U, nextTier: UnitPriorityTier): void {
    unit.tier = nextTier;
    if (!unit.queued) return;
    this.enqueue(unit, nextTier);
  }

  remove(unit: U): void {
    this.removeFromBuckets(unit);
    unit.queued = false;
  }

  private removeFromBuckets(unit: U): void {
    this.visible.delete(unit);
    this.near.delete(unit);
    this.other.delete(unit);
  }

  clearQueue(): void {
    for (const u of this.visible) u.queued = false;
    for (const u of this.near) u.queued = false;
    for (const u of this.other) u.queued = false;
    this.visible.clear();
    this.near.clear();
    this.other.clear();
  }

  resetAll(): void {
    this.clearQueue();
    this.discoveredCount = 0;
    this.renderedCount = 0;
    this.failedCount = 0;
  }

  dequeueBatch(options: {
    maxItems: number;
    maxChars: number;
    getLength: (u: U) => number;
    includeOffscreen?: boolean;
    onDisconnected?: (u: U) => void;
  }): { batch: U[]; priority: UnitPriorityTier; chars: number } {
    const batch: U[] = [];
    let chars = 0;
    let topPriority: UnitPriorityTier = 2;
    const buckets: [Set<U>, UnitPriorityTier][] = options.includeOffscreen
      ? [
          [this.visible, 1],
          [this.near, 2],
          [this.other, 3],
        ]
      : [
          [this.visible, 1],
          [this.near, 2],
        ];

    for (const [bucket, tier] of buckets) {
      for (const u of bucket) {
        if (!u.isConnected()) {
          bucket.delete(u);
          u.queued = false;
          options.onDisconnected?.(u);
          continue;
        }
        const len = options.getLength(u);
        if (
          batch.length > 0 &&
          (batch.length >= options.maxItems || chars + len > options.maxChars)
        ) {
          return { batch, priority: topPriority, chars };
        }
        if (batch.length === 0) topPriority = tier;
        batch.push(u);
        chars += len;
        bucket.delete(u);
        u.queued = false;
        if (batch.length >= options.maxItems) {
          return { batch, priority: topPriority, chars };
        }
      }
    }
    return { batch, priority: topPriority, chars };
  }
}
