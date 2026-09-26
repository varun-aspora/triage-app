import { describe, expect, test } from 'bun:test';
import { ERROR_EVENT_CASES } from '../../test/support/error-event-cases.ts';
import { isErrorEvent } from './errors.ts';

describe('isErrorEvent', () => {
  for (const c of ERROR_EVENT_CASES) {
    test(`${c.name}: ${c.error ? 'error' : 'not an error'}`, () => {
      expect(isErrorEvent({ type: c.type, data: c.data })).toBe(c.error);
    });
  }
});
