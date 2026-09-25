import { Fragment, useEffect, useMemo, useState } from 'react';
import { getDoctor } from '../../api/endpoints.ts';
import type { DoctorCheck, DoctorResponse } from '../../api/types.ts';
import { Button } from '../../components/Button.tsx';
import { EmptyState } from '../../components/EmptyState.tsx';
import { Checkbox } from '../../components/Field.tsx';
import { ErrorNotice, Loading } from '../../components/LoadState.tsx';
import { PageHeader } from '../../components/PageHeader.tsx';
import { Panel } from '../../components/Panel.tsx';
import { Segmented } from '../../components/Segmented.tsx';
import { StatusTag } from '../../components/StatusTag.tsx';
import { DOCTOR_STATUSES, type DoctorStatus } from '../../lib/constants.ts';
import { formatDateTime } from '../../lib/format.ts';
import { doctorStatusTone } from '../../lib/status.ts';
import { useApi } from '../../lib/useApi.ts';
import { type DoctorSort, checkIds, filterChecks, groupChecks, toggle } from './doctor-model.ts';

const SORTS = [
  { value: 'entity', label: 'By entity' },
  { value: 'check', label: 'By check' },
] as const;

const PROBLEMS: readonly DoctorStatus[] = ['warn', 'fail'];

export default function DoctorPage() {
  const [sortBy, setSortBy] = useState<DoctorSort>('entity');
  const [statuses, setStatuses] = useState<DoctorStatus[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [lastRun, setLastRun] = useState<string | null>(null);

  // One request per page load or "Run again". Sorting and filtering happen on
  // the rows already received, because every request runs the live probes.
  const doctor = useApi((signal) => getDoctor({}, { signal }), []);
  const data = doctor.data;

  useEffect(() => {
    if (data !== undefined) setLastRun(new Date().toISOString());
  }, [data]);

  const knownChecks = useMemo(() => (data === undefined ? [] : checkIds(data.checks)), [data]);
  const rows = useMemo(
    () => (data === undefined ? [] : filterChecks(data.checks, { statuses, checks: selected })),
    [data, statuses, selected],
  );
  const problemsOnly = statuses.length === PROBLEMS.length && PROBLEMS.every((s) => statuses.includes(s));
  const filtered = statuses.length > 0 || selected.length > 0;

  return (
    <>
      <PageHeader
        title="Doctor"
        description="Checks this server's config, credentials and connections. Rows name env keys, never their values, and no customer data is read."
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {lastRun !== null && (
              <span className="hint" style={{ margin: 0 }}>
                Last run {formatDateTime(lastRun)}
              </span>
            )}
            <Button variant="primary" icon="refresh" busy={doctor.loading} onClick={doctor.reload}>
              {doctor.loading ? 'Running checks…' : 'Run again'}
            </Button>
          </div>
        }
      />

      {data !== undefined && (
        <Counts counts={data.counts} selected={statuses} onToggle={(s) => setStatuses((cur) => toggle(cur, s))} />
      )}

      <div style={{ display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap' }}>
        <Segmented label="Sort by" options={SORTS} value={sortBy} onChange={setSortBy} />
        <Checkbox
          label="Problems only"
          checked={problemsOnly}
          onChange={(e) => setStatuses(e.target.checked ? [...PROBLEMS] : [])}
        />
        {knownChecks.length > 0 && (
          <div role="group" aria-label="Checks" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {knownChecks.map((id) => (
              <CheckChip key={id} id={id} on={selected.includes(id)} onToggle={() => setSelected((s) => toggle(s, id))} />
            ))}
          </div>
        )}
        {filtered && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setStatuses([]);
              setSelected([]);
            }}
          >
            Clear filters
          </Button>
        )}
      </div>

      {doctor.loading && <Loading label="Running checks…" />}
      {!doctor.loading && doctor.error !== undefined && (
        <ErrorNotice title="Could not run the checks" error={doctor.error} onRetry={doctor.reload} />
      )}
      {!doctor.loading && data !== undefined && <ChecksTable checks={rows} sortBy={sortBy} filtered={filtered} />}
    </>
  );
}

/** Row tint for the statuses that need someone to act; ok, disabled and skipped stay plain. */
function problemRowClass(status: DoctorCheck['status']): string | undefined {
  if (status === 'fail') return 'row-rust';
  if (status === 'warn') return 'row-amber';
  return undefined;
}

function Counts({
  counts,
  selected,
  onToggle,
}: {
  counts: DoctorResponse['counts'];
  selected: readonly DoctorStatus[];
  onToggle: (s: DoctorStatus) => void;
}) {
  return (
    <div role="group" aria-label="Filter by status" style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
      {DOCTOR_STATUSES.map((status) => {
        const n = counts[status] ?? 0;
        const on = selected.includes(status);
        // Tint only when there is something to fix, so a clean run looks calm.
        const tone = n > 0 ? (status === 'fail' ? 'rust' : status === 'warn' ? 'amber' : null) : null;
        return (
          <button
            key={status}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(status)}
            style={{
              flex: '1 1 120px',
              padding: '12px 16px',
              textAlign: 'left',
              font: 'inherit',
              cursor: 'pointer',
              background: tone === null ? 'var(--surface)' : `var(--tone-${tone}-row)`,
              border: `1px solid ${tone === null ? 'var(--line)' : `var(--tone-${tone}-fg)`}`,
              borderRadius: 'var(--radius-lg)',
              // The ring marks the active filter; unselected tiles fade while any filter is on.
              boxShadow: on ? '0 0 0 2px var(--text)' : 'none',
              opacity: selected.length > 0 && !on ? 0.55 : 1,
            }}
          >
            <div style={{ margin: '0 0 6px' }}>
              <StatusTag look={doctorStatusTone(status)}>{status}</StatusTag>
            </div>
            <div style={{ fontSize: 24, fontWeight: 600, color: tone === null ? 'var(--text)' : `var(--tone-${tone}-fg)` }}>{n}</div>
          </button>
        );
      })}
    </div>
  );
}

function CheckChip({ id, on, onToggle }: { id: string; on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      className="mono"
      onClick={onToggle}
      style={{
        height: 28,
        padding: '0 10px',
        borderRadius: 14,
        border: `1px solid ${on ? 'var(--accent)' : 'var(--field-line)'}`,
        background: on ? 'var(--accent-soft)' : 'var(--surface)',
        color: on ? 'var(--text)' : 'var(--text-2)',
        fontSize: 12,
        fontWeight: on ? 600 : 400,
        cursor: 'pointer',
      }}
    >
      {id}
    </button>
  );
}

function ChecksTable({ checks, sortBy, filtered }: { checks: DoctorCheck[]; sortBy: DoctorSort; filtered: boolean }) {
  if (checks.length === 0) {
    return (
      <Panel>
        {filtered ? (
          <EmptyState icon="check" title="Nothing matches">
            No check has the selected status. Clear the filters to see every row.
          </EmptyState>
        ) : (
          <EmptyState icon="doctor" title="No checks">
            The server returned no checks.
          </EmptyState>
        )}
      </Panel>
    );
  }
  return (
    <Panel padded={false}>
      <div style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead>
            <tr>
              <th scope="col" style={{ width: 110 }}>
                Check
              </th>
              <th scope="col" style={{ width: 110 }}>
                Status
              </th>
              <th scope="col" style={{ width: 300 }}>
                Keys
              </th>
              <th scope="col">Message</th>
            </tr>
          </thead>
          <tbody>
            {groupChecks(checks, sortBy).map((group) => (
              <Fragment key={group.label}>
                <tr>
                  <th
                    scope="rowgroup"
                    colSpan={4}
                    style={{ background: 'var(--surface-sunk)', fontSize: 12, fontWeight: 600, color: 'var(--text-2)', padding: '8px 12px' }}
                  >
                    {group.label}
                  </th>
                </tr>
                {group.rows.map((c, i) => (
                  <tr key={`${c.id}-${i}`} className={problemRowClass(c.status)}>
                    <td className="mono" style={{ fontSize: 13, fontWeight: 500 }}>
                      {c.id}
                    </td>
                    <td>
                      <StatusTag look={doctorStatusTone(c.status)}>{c.status}</StatusTag>
                    </td>
                    <td>
                      {c.key_names.length === 0 ? (
                        <span className="faint">—</span>
                      ) : (
                        c.key_names.map((k) => (
                          <span
                            key={k}
                            className="mono"
                            style={{
                              display: 'inline-block',
                              fontSize: 11,
                              padding: '1px 6px',
                              margin: '0 4px 4px 0',
                              borderRadius: 4,
                              background: 'var(--tone-muted-bg)',
                            }}
                          >
                            {k}
                          </span>
                        ))
                      )}
                    </td>
                    <td className="row-message" style={{ fontSize: 13, lineHeight: 1.45 }}>
                      {c.message}
                    </td>
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
