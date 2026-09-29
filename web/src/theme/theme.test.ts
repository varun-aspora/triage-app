import { describe, expect, test } from 'bun:test';
import { THEMES, bannerNote } from './theme.ts';

describe('bannerNote', () => {
  const np = THEMES['non-production'];

  test('production keeps its note with or without a session', () => {
    expect(bannerNote(THEMES.production, undefined)).toBe('Real customer data. Every read is audited.');
    expect(bannerNote(THEMES.production, { mock_mode: true })).toBe('Real customer data. Every read is audited.');
  });

  test('non-production follows the session mode', () => {
    expect(bannerNote(np, { mock_mode: true })).toBe('Mock mode: tools answer from reviewed fixtures.');
    expect(bannerNote(np, { mock_mode: false })).toBe('Live mode: tools read real systems, read-only.');
  });

  test('no session, no mode note', () => {
    expect(bannerNote(np, undefined)).toBeUndefined();
  });
});
