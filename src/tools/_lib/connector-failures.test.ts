// The per-run connector failure record (D55). Every value is synthetic.
import { afterEach, describe, expect, test } from 'bun:test';
import type { ConnectorFailure } from '../../types/block.ts';
import { connectorFailuresFor, recordConnectorFailure, releaseConnectorFailures } from './connector-failures.ts';

const AT = '2026-09-23T10:00:00.000Z';
const LATER = '2026-09-23T10:00:05.000Z';

let seq = 0;
const runs: string[] = [];
function runId(): string {
  seq += 1;
  const id = `run_failures_${seq}`;
  runs.push(id);
  return id;
}

const failure = (system: string, code: ConnectorFailure['code'] = 'unreachable', at = AT): ConnectorFailure => ({
  system,
  tool: 'sql_select',
  code,
  at,
});

afterEach(() => {
  for (const id of runs.splice(0)) releaseConnectorFailures(id);
});

describe('connector failures', () => {
  test('a run with no record reads as empty', () => {
    expect(connectorFailuresFor(runId())).toEqual([]);
  });

  test('records failures in order and reads them back as copies', () => {
    const id = runId();
    recordConnectorFailure(id, failure('ssfb:harbor'));
    recordConnectorFailure(id, failure('atspl:package', 'timeout', LATER));
    recordConnectorFailure(id, failure('ssfb:harbor', 'error', LATER));
    const list = connectorFailuresFor(id);
    expect(list).toEqual([
      { system: 'ssfb:harbor', tool: 'sql_select', code: 'unreachable', at: AT },
      { system: 'atspl:package', tool: 'sql_select', code: 'timeout', at: LATER },
      { system: 'ssfb:harbor', tool: 'sql_select', code: 'error', at: LATER },
    ]);
    // Changing what came back changes nothing in the record.
    (list as ConnectorFailure[]).pop();
    (list[0] as { system: string }).system = 'changed';
    expect(connectorFailuresFor(id)).toHaveLength(3);
    expect(connectorFailuresFor(id)[0]?.system).toBe('ssfb:harbor');
  });

  test('the value recorded is a copy too', () => {
    const id = runId();
    const given = failure('rtl:core');
    recordConnectorFailure(id, given);
    (given as { code: string }).code = 'timeout';
    expect(connectorFailuresFor(id)[0]?.code).toBe('unreachable');
  });

  test('runs never share a record', () => {
    const a = runId();
    const b = runId();
    recordConnectorFailure(a, failure('ssfb:harbor'));
    expect(connectorFailuresFor(b)).toEqual([]);
    recordConnectorFailure(b, failure('atspl:package'));
    expect(connectorFailuresFor(a).map((f) => f.system)).toEqual(['ssfb:harbor']);
    expect(connectorFailuresFor(b).map((f) => f.system)).toEqual(['atspl:package']);
  });

  test('release drops the record and says whether there was one', () => {
    const id = runId();
    expect(releaseConnectorFailures(id)).toBe(false);
    recordConnectorFailure(id, failure('ssfb:harbor'));
    expect(releaseConnectorFailures(id)).toBe(true);
    expect(connectorFailuresFor(id)).toEqual([]);
    expect(releaseConnectorFailures(id)).toBe(false);
  });

  test('refuses a failure that does not fit the record and a bad run id', () => {
    const id = runId();
    expect(() => recordConnectorFailure(id, { ...failure('ssfb:harbor'), code: 'not_configured' as never })).toThrow();
    expect(() => recordConnectorFailure(id, { ...failure('ssfb:harbor'), at: 'yesterday' })).toThrow();
    expect(() => recordConnectorFailure(id, { ...failure(''), system: '' })).toThrow();
    expect(() => recordConnectorFailure('not a run id', failure('ssfb:harbor'))).toThrow();
    expect(connectorFailuresFor(id)).toEqual([]);
  });
});
