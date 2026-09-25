import { describe, expect, test } from 'bun:test';
import type { RunRecord } from '../runstore/types.ts';
import type { Report } from '../types/report.ts';
import { findingIdProblem, findingRefs, parseFindingId } from './finding-refs.ts';

const run: Pick<RunRecord, 'evidence' | 'report'> = {
  evidence: {
    ssfb: {
      key: 'ssfb',
      version: 2,
      findings: {
        evidence: [
          { source: 'db', at: '2026-09-20T10:00:00.000Z', query_or_path: 'select 1', summary: 'dispatch rejected' },
          { source: 'logs', at: '2026-09-20T10:01:00.000Z', query_or_path: '', summary: 'no callback' },
        ],
        timeline: [],
        hypotheses: ['address rejected'],
        confidence: 'medium',
        gaps: [],
      },
    },
    code: {
      key: 'code',
      version: 1,
      findings: { claims: [{ repo: 'rhythm', file: 'a.ts', lines: '1-9', what_it_shows: 'no retry' }], confidence: 'high' },
    },
  },
  report: { root_cause: { statement: 'the vendor rejected the address', code_refs: [] } } as unknown as Report,
};

describe('findingRefs', () => {
  test('lists evidence, hypotheses and code claims of the latest versions, then the root cause', () => {
    expect(findingRefs(run)).toEqual([
      { id: 'ssfb.v2.e1', kind: 'evidence', key: 'ssfb', version: 2, text: 'dispatch rejected', detail: 'db · select 1' },
      { id: 'ssfb.v2.e2', kind: 'evidence', key: 'ssfb', version: 2, text: 'no callback', detail: 'logs' },
      { id: 'ssfb.v2.h1', kind: 'hypothesis', key: 'ssfb', version: 2, text: 'address rejected' },
      { id: 'code.v1.c1', kind: 'code_claim', key: 'code', version: 1, text: 'no retry', detail: 'rhythm/a.ts:1-9' },
      { id: 'root_cause', kind: 'root_cause', key: null, version: null, text: 'the vendor rejected the address' },
    ]);
  });

  test('a run with no evidence and no report has none', () => {
    expect(findingRefs({ evidence: {}, report: null })).toEqual([]);
  });
});

describe('finding ids', () => {
  test('parse', () => {
    expect(parseFindingId('ssfb.v12.e3')).toEqual({ kind: 'evidence', key: 'ssfb', version: 12, index: 3 });
    expect(parseFindingId('code.v1.c1')).toEqual({ kind: 'code_claim', key: 'code', version: 1, index: 1 });
    expect(parseFindingId('root_cause')).toEqual({ kind: 'root_cause' });
    for (const bad of ['ssfb.v0.e1', 'ssfb.v1.e0', 'code.v1.e1', 'ssfb.v1.c1', 'other.v1.e1', 'ssfb.1.e1', '']) expect(parseFindingId(bad)).toBeNull();
  });

  test('findingIdProblem accepts ids the run has, older versions included', () => {
    const refs = findingRefs(run);
    expect(findingIdProblem('ssfb.v2.e2', run, refs)).toBeNull();
    expect(findingIdProblem('ssfb.v1.e7', run, refs)).toBeNull();
    expect(findingIdProblem('root_cause', run, refs)).toBeNull();
    expect(findingIdProblem('ssfb.v2.e3', run, refs)).toBe('names findings the run does not have');
    expect(findingIdProblem('ssfb.v3.e1', run, refs)).toBe('names findings the run does not have');
    expect(findingIdProblem('atspl.v1.e1', run, refs)).toBe('names findings the run does not have');
    expect(findingIdProblem('nonsense', run, refs)).toBe('is not a finding id');
    expect(findingIdProblem('root_cause', { evidence: {}, report: null }, [])).toBe('the run has no root cause yet');
  });
});
