import { Fragment, useEffect, useState } from 'react';
import { ApiError } from '../../api/client.ts';
import { getDoctor } from '../../api/endpoints.ts';
import type { DoctorCheck, DoctorResponse } from '../../api/types.ts';
import { Button } from '../../components/Button.tsx';
import { EmptyState } from '../../components/EmptyState.tsx';
import { Checkbox } from '../../components/Field.tsx';
import { ErrorNotice, Loading } from '../../components/LoadState.tsx';
import { Notice } from '../../components/Notice.tsx';
import { PageHeader } from '../../components/PageHeader.tsx';
import { Panel } from '../../components/Panel.tsx';
import { Segmented } from '../../components/Segmented.tsx';
import { StatusTag } from '../../components/StatusTag.tsx';
import { DOCTOR_STATUSES } from '../../lib/constants.ts';
import { formatDateTime } from '../../lib/format.ts';
import { doctorStatusTone } from '../../lib/status.ts';
import { useApi } from '../../lib/useApi.ts';
import { type DoctorSort, checkIds, groupChecks, toggle } from './doctor-model.ts';

const SORTS = [
  { value: 'entity', label: 'By entity' },
  { value: 'check', label: 'By check' },
] as const;

export default function DoctorPage() {
  const [sortBy, setSortBy] = useState<DoctorSort>('entity');
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  // Filter chips come from the last answer that was not narrowed, so picking one chip does not hide the others.
  const [knownChecks, setKnownChecks] = useState<string[]>([]);
  const [lastRun, setLastRun] = useState<string | null>(null);
  const [rerunning, setRerunning] = useState(false);
  const [resetNotice, setResetNotice] = useState(false);

  // No polling: every request runs the live probes.
  const doctor = useApi(
    (signal) => getDoctor({ check: selected, errorsOnly, sortBy }, { signal }),
    [sortBy, errorsOnly, selected.join(',')],
  );
  const unfiltered = selected.length === 0 && !errorsOnly;

  useEffect(() => {
    if (doctor.data === undefined) return;
    setLastRun(new Date().toISOString());
    if (unfiltered) setKnownChecks(checkIds(doctor.data.checks));
  }, [doctor.data]);

  useEffect(() => {
    setRerunning(false);
    const err = doctor.error;
    // A check id the server no longer knows (for example after a restart with other entities): start over.
    if (isUnknownCheck(err)) {
      setKnownChecks(err.body.valid_checks ?? []);
      setSelected([]);
      setResetNotice(true);
    }
  }, [doctor.error]);

  useEffect(() => setRerunning(false), [doctor.data]);

  const runAgain = () => {
    setRerunning(true);
    setResetNotice(false);
    doctor.reload();
  };

  const busy = doctor.loading || rerunning;
  const data = doctor.data;

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
            <Button variant="primary" icon="refresh" busy={busy} onClick={runAgain}>
              {busy ? 'Running checks…' : 'Run again'}
            </Button>
          </div>
        }
      />

      {resetNotice && (
        <Notice variant="info" title="Check filter cleared">
          The server did not recognise one of the selected checks, so all checks are shown.
        </Notice>
      )}

      {data !== undefined && <Counts counts={data.counts} />}

      <div style={{ display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap' }}>
        <Segmented label="Sort by" options={SORTS} value={sortBy} onChange={setSortBy} />
        <Checkbox label="Problems only" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} />
        {knownChecks.length > 0 && (
          <div role="group" aria-label="Checks" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {knownChecks.map((id) => (
              <CheckChip key={id} id={id} on={selected.includes(id)} onToggle={() => setSelected((s) => toggle(s, id))} />
            ))}
            {selected.length > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
                Clear
              </Button>
            )}
          </div>
        )}
      </div>

      {doctor.loading && <Loading label="Running checks…" />}
      {!doctor.loading && doctor.error !== undefined && !isUnknownCheck(doctor.error) && (
        <ErrorNotice title="Could not run the checks" error={doctor.error} onRetry={runAgain} />
      )}
      {!doctor.loading && data !== undefined && <ChecksTable checks={data.checks} sortBy={sortBy} errorsOnly={errorsOnly} />}
    </>
  );
}

/** Row tint for the statuses that need someone to act; ok, disabled and skipped stay plain. */
function problemRowClass(status: DoctorCheck['status']): string | undefined {
  if (status === 'fail') return 'row-rust';
  if (status === 'warn') return 'row-amber';
  return undefined;
}

function isUnknownCheck(err: unknown): err is ApiError {
  return err instanceof ApiError && err.status === 400 && err.body.valid_checks !== undefined;
}

function Counts({ counts }: { counts: DoctorResponse['counts'] }) {
  return (
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
      {DOCTOR_STATUSES.map((status) => {
        const n = counts[status] ?? 0;
        // Tint only when there is something to fix, so a clean run looks calm.
        const tone = n > 0 ? (status === 'fail' ? 'rust' : status === 'warn' ? 'amber' : null) : null;
        return (
          <div
            key={status}
            style={{
              flex: '1 1 120px',
              padding: '12px 16px',
              background: tone === null ? 'var(--surface)' : `var(--tone-${tone}-row)`,
              border: `1px solid ${tone === null ? 'var(--line)' : `var(--tone-${tone}-fg)`}`,
              borderRadius: 'var(--radius-lg)',
            }}
          >
            <div style={{ margin: '0 0 6px' }}>
              <StatusTag look={doctorStatusTone(status)}>{status}</StatusTag>
            </div>
            <div style={{ fontSize: 24, fontWeight: 600, color: tone === null ? undefined : `var(--tone-${tone}-fg)` }}>{n}</div>
          </div>
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

function ChecksTable({ checks, sortBy, errorsOnly }: { checks: DoctorCheck[]; sortBy: DoctorSort; errorsOnly: boolean }) {
  if (checks.length === 0) {
    return (
      <Panel>
        {errorsOnly ? (
          <EmptyState icon="check" title="No problems">
            Every selected check passed, is turned off or was skipped.
          </EmptyState>
        ) : (
          <EmptyState icon="doctor" title="No checks">
            The server returned no checks for this filter.
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
