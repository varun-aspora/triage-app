import { afterEach, describe, expect, test } from 'bun:test';
import { quickwitSlot, resetQuickwitSlotsForTests } from './semaphore.ts';

afterEach(() => resetQuickwitSlotsForTests());

// Lets pending promise callbacks run.
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('quickwitSlot', () => {
  test('semaphore: cap 1, two acquires -> second resolves only after first release (ordering asserted)', async () => {
    const slot = quickwitSlot('ssfb', 1);
    const order: string[] = [];

    const releaseA = await slot.acquire();
    order.push('a acquired');
    const second = slot.acquire().then((release) => {
      order.push('b acquired');
      return release;
    });

    await tick();
    expect(order).toEqual(['a acquired']);
    expect(slot.stats()).toEqual({ active: 1, waiting: 1 });

    order.push('a released');
    releaseA();
    const releaseB = await second;
    expect(order).toEqual(['a acquired', 'a released', 'b acquired']);
    expect(slot.stats()).toEqual({ active: 1, waiting: 0 });

    releaseB();
    expect(slot.stats()).toEqual({ active: 0, waiting: 0 });
  });

  test('waiters are served first in, first out', async () => {
    const slot = quickwitSlot('ssfb', 1);
    const order: number[] = [];
    const first = await slot.acquire();
    const waits = [1, 2, 3].map((n) =>
      slot.acquire().then((release) => {
        order.push(n);
        release();
      }),
    );
    first();
    await Promise.all(waits);
    expect(order).toEqual([1, 2, 3]);
  });

  test('a new caller cannot jump ahead of a waiter', async () => {
    const slot = quickwitSlot('ssfb', 1);
    const order: string[] = [];
    const first = await slot.acquire();
    const waiter = slot.acquire().then((r) => {
      order.push('waiter');
      return r;
    });
    first();
    const late = slot.acquire().then((r) => {
      order.push('late');
      return r;
    });
    (await waiter)();
    (await late)();
    expect(order).toEqual(['waiter', 'late']);
  });

  test('other entities run independently of a full slot', async () => {
    const ssfb = quickwitSlot('ssfb', 1);
    const atspl = quickwitSlot('atspl', 1);
    const heldSsfb = await ssfb.acquire();

    let ssfbWaiterDone = false;
    const ssfbWaiter = ssfb.acquire().then((r) => {
      ssfbWaiterDone = true;
      return r;
    });
    const releaseAtspl = await atspl.acquire();
    await tick();
    expect(ssfbWaiterDone).toBe(false);
    expect(atspl.stats()).toEqual({ active: 1, waiting: 0 });

    releaseAtspl();
    heldSsfb();
    (await ssfbWaiter)();
  });

  test('cap 2 lets two holders in and queues the third', async () => {
    const slot = quickwitSlot('rtl', 2);
    const a = await slot.acquire();
    const b = await slot.acquire();
    let thirdDone = false;
    const third = slot.acquire().then((r) => {
      thirdDone = true;
      return r;
    });
    await tick();
    expect(thirdDone).toBe(false);
    a();
    (await third)();
    b();
    expect(slot.stats()).toEqual({ active: 0, waiting: 0 });
  });

  test('the same entity returns the same process-wide slot', () => {
    expect(quickwitSlot('ssfb', 1)).toBe(quickwitSlot('ssfb', 1));
  });
});

describe('abort and release', () => {
  test('semaphore: aborting a waiting acquire rejects it and does not consume the slot', async () => {
    const slot = quickwitSlot('ssfb', 1);
    const held = await slot.acquire();
    const controller = new AbortController();
    const waiting = slot.acquire(controller.signal);
    const after = slot.acquire();

    controller.abort(new Error('run cancelled'));
    await expect(waiting).rejects.toThrow('run cancelled');
    expect(slot.stats()).toEqual({ active: 1, waiting: 1 });

    // The aborted waiter is skipped: the next waiter gets the slot.
    held();
    const releaseAfter = await after;
    expect(slot.stats()).toEqual({ active: 1, waiting: 0 });
    releaseAfter();
    expect(slot.stats()).toEqual({ active: 0, waiting: 0 });
  });

  test('deny: acquire with an already aborted signal rejects without taking a slot', async () => {
    const slot = quickwitSlot('ssfb', 1);
    const controller = new AbortController();
    controller.abort();
    await expect(slot.acquire(controller.signal)).rejects.toBeDefined();
    expect(slot.stats()).toEqual({ active: 0, waiting: 0 });
  });

  test('aborting while holding releases the slot', async () => {
    const slot = quickwitSlot('ssfb', 1);
    const controller = new AbortController();
    const release = await slot.acquire(controller.signal);
    const next = slot.acquire();
    controller.abort();
    (await next)();
    // A late release from the aborted holder is a no-op.
    release();
    expect(slot.stats()).toEqual({ active: 0, waiting: 0 });
  });

  test('semaphore: release after throw in the holder frees the slot', async () => {
    const slot = quickwitSlot('ssfb', 1);
    await expect(
      slot.run(async () => {
        throw new Error('quickwit 500');
      }),
    ).rejects.toThrow('quickwit 500');
    expect(slot.stats()).toEqual({ active: 0, waiting: 0 });

    const release = await slot.acquire();
    expect(slot.stats().active).toBe(1);
    release();
  });

  test('run() returns the value and hands the slot to the next waiter', async () => {
    const slot = quickwitSlot('ssfb', 1);
    const order: string[] = [];
    const a = slot.run(async () => {
      await tick();
      order.push('a');
      return 'a';
    });
    const b = slot.run(async () => {
      order.push('b');
      return 'b';
    });
    expect(await Promise.all([a, b])).toEqual(['a', 'b']);
    expect(order).toEqual(['a', 'b']);
    expect(slot.stats()).toEqual({ active: 0, waiting: 0 });
  });

  test('releasing twice does not free a second slot', async () => {
    const slot = quickwitSlot('ssfb', 1);
    const a = await slot.acquire();
    const bPromise = slot.acquire();
    a();
    const b = await bPromise;
    a();
    expect(slot.stats().active).toBe(1);
    let cDone = false;
    const c = slot.acquire().then((r) => {
      cDone = true;
      return r;
    });
    await tick();
    expect(cDone).toBe(false);
    b();
    (await c)();
  });
});

describe('construction', () => {
  test('deny: invalid caps throw', () => {
    for (const cap of [0, -1, 1.5, Number.NaN]) {
      expect(() => quickwitSlot('ssfb', cap)).toThrow(RangeError);
    }
  });

  test('deny: unknown entity throws', () => {
    expect(() => quickwitSlot('shivalik' as never, 1)).toThrow(RangeError);
  });

  test('deny: a different cap for an existing entity slot throws', () => {
    quickwitSlot('ssfb', 1);
    expect(() => quickwitSlot('ssfb', 2)).toThrow(RangeError);
  });
});
