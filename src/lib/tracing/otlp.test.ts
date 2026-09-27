import { describe, expect, test } from 'bun:test';
import { parseHeaders } from './otlp.ts';

describe('parseHeaders', () => {
  test('splits pairs on the first =, so base64 values survive', () => {
    expect(parseHeaders('Authorization=Basic cGs6c2s=, x-bt-parent=project_name:triage-app')).toEqual({
      Authorization: 'Basic cGs6c2s=',
      'x-bt-parent': 'project_name:triage-app',
    });
  });

  test('blank or malformed input gives no headers', () => {
    expect(parseHeaders(undefined)).toEqual({});
    expect(parseHeaders('novalue,=x')).toEqual({});
  });
});
