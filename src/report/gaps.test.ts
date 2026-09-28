import { describe, expect, test } from 'bun:test';

import { makeToolContext } from '../../test/support/fake-tool-context.ts';
import { mergeGaps, registryNames } from './gaps.ts';

// All values are synthetic.
describe('mergeGaps', () => {
  test('exact repeats and case or punctuation changes collapse to one line', () => {
    expect(mergeGaps(['ssfb: logs unreachable', 'SSFB logs unreachable.', 'ssfb: logs unreachable'])).toEqual([
      'ssfb: logs unreachable',
    ]);
  });

  test('a line contained in a longer one is replaced by the longer, at the first position', () => {
    const gaps = [
      'harbor form not found',
      'rtl workflow rows not read',
      'harbor form not found for the device id before VERIFIED',
    ];
    expect(mergeGaps(gaps)).toEqual([
      'harbor form not found for the device id before VERIFIED',
      'rtl workflow rows not read',
    ]);
  });

  test('ids, UUIDs and timestamps do not keep two lines apart', () => {
    const gaps = [
      'no guardian callback for attempt 1234 after 2026-09-07T10:03:57Z',
      'no guardian callback for attempt 5678 after 2026-09-07 11:00',
      'no rows for 0f8b1c2e-1111-4222-8333-944455556666 in harbor',
      'no rows for 9a8b7c6d-aaaa-4bbb-8ccc-dddddddddddd in harbor',
    ];
    expect(mergeGaps(gaps)).toEqual([gaps[0]!, gaps[2]!]);
  });

  test('similar lines that name different entities or services stay apart', () => {
    const gaps = [
      'ssfb attempts table was not queried by device id within the window',
      'rtl attempts table was not queried by device id within the window',
      'guardian-service callbacks could not be searched for the device within the run window',
      'harbor-service callbacks could not be searched for the device within the run window',
    ];
    expect(mergeGaps(gaps)).toEqual(gaps);
  });

  test('containment needs the shorter line as one phrase in order, not just its words', () => {
    const probes = [
      ['guardian logs not searched', 'guardian logs searched but kong-vendor webhook logs not searched'],
      ['refresh_tokens not read', 'refresh_tokens read, device_auth_attempts not read'],
      ['harbor form found', 'harbor form not found'],
    ];
    for (const gaps of probes) expect(mergeGaps(gaps)).toEqual(gaps);
  });

  test('long lines that differ only by a plain registry service name stay apart', () => {
    const names = registryNames(makeToolContext().registry);
    expect(names.has('guardian') && names.has('harbor') && names.has('workflow-op-service')).toBe(true);
    const gaps = [
      'guardian status polls for the device were not read over the attempt windows yesterday',
      'harbor status polls for the device were not read over the attempt windows yesterday',
    ];
    expect(mergeGaps(gaps, names)).toEqual(gaps);
  });

  test('close wording with one word changed merges; the first line wins a tie', () => {
    const gaps = [
      'guardian callback logs for the sms step were not searched in the run window',
      'guardian callback logs for the sms step were never searched in the run window',
    ];
    expect(mergeGaps(gaps)).toEqual([gaps[0]!]);
  });

  test('short lines need more than a shared word or two', () => {
    expect(mergeGaps(['no rows', 'no rows found', 'tunnel down'])).toEqual(['no rows', 'no rows found', 'tunnel down']);
  });

  test('lines with no words keep an exact-match dedupe; the same input gives the same output', () => {
    const gaps = ['--', '--', '', 'cost not recorded', 'Cost not recorded!'];
    expect(mergeGaps(gaps)).toEqual(['--', '', 'cost not recorded']);
    expect(mergeGaps(gaps)).toEqual(mergeGaps([...gaps]));
    expect(mergeGaps([])).toEqual([]);
  });
});
