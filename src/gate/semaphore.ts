// The per-entity Quickwit concurrency cap. Fan-out without a cap once took
// down a single-CPU Quickwit, so every Quickwit call, over either transport,
// holds a slot from here while it runs. There is one FIFO semaphore per entity
// for the whole process. This is the only semaphore in the repo: the Quickwit
// connector acquires quickwitSlot and nothing else builds its own.
import * as v from 'valibot';
import { type Entity, EntitySchema } from '../types/core.ts';

// Calling it more than once is safe; only the first call frees the slot.
export type Release = () => void;

export interface QuickwitSlot {
  readonly entity: Entity;
  readonly maxConcurrency: number;
  // Resolves with a release function once a slot is free. A waiting acquire
  // whose signal aborts rejects and takes no slot. If the signal aborts while
  // the slot is held, the slot is released.
  acquire(signal?: AbortSignal): Promise<Release>;
  // Runs fn while holding a slot and always releases it, including on throw.
  run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  // For tests and diagnostics.
  stats(): { active: number; waiting: number };
}

interface Waiter {
  grant: () => void;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

function createSlot(entity: Entity, maxConcurrency: number): QuickwitSlot {
  let active = 0;
  const queue: Waiter[] = [];

  const makeRelease = (signal?: AbortSignal): Release => {
    let released = false;
    const release: Release = () => {
      if (released) return;
      released = true;
      signal?.removeEventListener('abort', release);
      const next = queue.shift();
      // Hand the slot straight to the next waiter so active never drops and
      // a new caller cannot jump the queue.
      if (next !== undefined) next.grant();
      else active -= 1;
    };
    signal?.addEventListener('abort', release, { once: true });
    return release;
  };

  const slot: QuickwitSlot = {
    entity,
    maxConcurrency,

    acquire(signal) {
      if (signal?.aborted) return Promise.reject(abortReason(signal));
      if (active < maxConcurrency && queue.length === 0) {
        active += 1;
        return Promise.resolve(makeRelease(signal));
      }
      return new Promise<Release>((resolve, reject) => {
        const onAbort = (): void => {
          const i = queue.indexOf(waiter);
          if (i !== -1) queue.splice(i, 1);
          reject(abortReason(signal as AbortSignal));
        };
        const waiter: Waiter = {
          grant: () => {
            signal?.removeEventListener('abort', onAbort);
            resolve(makeRelease(signal));
          },
        };
        queue.push(waiter);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },

    async run(fn, signal) {
      const release = await slot.acquire(signal);
      try {
        return await fn();
      } finally {
        release();
      }
    },

    stats() {
      return { active, waiting: queue.length };
    },
  };
  return slot;
}

const slots = new Map<Entity, QuickwitSlot>();

// Returns the process-wide slot for this entity, creating it on first use.
// The cap comes from <ENTITY>_QUICKWIT_MAX_CONCURRENCY through the registry;
// asking again with a different cap throws, because two callers disagreeing
// on the cap is a wiring bug.
export function quickwitSlot(entity: Entity, maxConcurrency: number): QuickwitSlot {
  if (!v.is(EntitySchema, entity)) throw new RangeError(`unknown entity: ${String(entity)}`);
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new RangeError(`maxConcurrency must be a positive integer, got ${String(maxConcurrency)}`);
  }
  const existing = slots.get(entity);
  if (existing !== undefined) {
    if (existing.maxConcurrency !== maxConcurrency) {
      throw new RangeError(
        `quickwit slot for ${entity} already has cap ${existing.maxConcurrency}, asked for ${maxConcurrency}`,
      );
    }
    return existing;
  }
  const created = createSlot(entity, maxConcurrency);
  slots.set(entity, created);
  return created;
}

// Tests only: forget every slot so the next test can pick its own cap.
export function resetQuickwitSlotsForTests(): void {
  slots.clear();
}
