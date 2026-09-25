import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../../api/client.ts';
import { getRepoSync, getRepos, listServices, startRepoSync } from '../../api/endpoints.ts';
import type { Entity, RepoStatusRow, ReposResponse, SyncJob } from '../../api/types.ts';
import { Button } from '../../components/Button.tsx';
import { EmptyState } from '../../components/EmptyState.tsx';
import { Input, Label, Select } from '../../components/Field.tsx';
import { Icon } from '../../components/Icon.tsx';
import { ErrorNotice, Loading } from '../../components/LoadState.tsx';
import { Notice } from '../../components/Notice.tsx';
import { PageHeader } from '../../components/PageHeader.tsx';
import { Panel } from '../../components/Panel.tsx';
import { StatusTag } from '../../components/StatusTag.tsx';
import { ENTITIES } from '../../lib/constants.ts';
import { formatDateTime, formatDuration, shortRunId } from '../../lib/format.ts';
import { syncResultTone } from '../../lib/status.ts';
import { safeGet, safeRemove, safeSet } from '../../lib/storage.ts';
import { useApi } from '../../lib/useApi.ts';
import {
  REPO_STATES,
  type RepoFilter,
  type RepoState,
  countsLine,
  entitiesByRepo,
  filterRepos,
  problemNames,
  shortCommit,
  triggerLabel,
} from './repos-model.ts';

// Kept in sessionStorage so a reload keeps following the sync this tab started.
const SYNC_KEY = 'triage.repos.sync';
const JOB_POLL_MS = 2000;
const OTHER_POLL_MS = 5000;

export default function ReposPage() {
  const [activeId, setActiveId] = useState<string | null>(() => safeGet('session', SYNC_KEY));
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<unknown>(undefined);
  // A 409 without a sync id: another sync runs that this tab cannot follow.
  const [waitingForOther, setWaitingForOther] = useState(false);
  const [lostNotice, setLostNotice] = useState(false);
  const [filter, setFilter] = useState<RepoFilter>({ q: '', entity: 'All', state: 'All' });

  // Read by the repos poll, which is set up once and must see the latest value.
  const ownRunningRef = useRef(false);

  const repos = useApi((signal) => getRepos({ signal }), [], {
    pollMs: OTHER_POLL_MS,
    // Only while a sync this tab is not following is running; our own is polled through its id.
    pollWhile: (d) => !ownRunningRef.current && d.sync.running,
  });
  const services = useApi((signal) => listServices({ signal }), []);
  const job = useApi<SyncJob | null>((signal) => (activeId === null ? Promise.resolve(null) : getRepoSync(activeId, { signal })), [activeId], {
    pollMs: JOB_POLL_MS,
    pollWhile: (j) => j?.status === 'running',
  });

  const setActive = (id: string | null) => {
    if (id === null) safeRemove('session', SYNC_KEY);
    else safeSet('session', SYNC_KEY, id);
    setActiveId(id);
  };

  // When our sync finishes: stop remembering it across reloads and refresh the table.
  const lastStatus = useRef<SyncJob['status'] | undefined>(undefined);
  useEffect(() => {
    const status = job.data?.status;
    if (status !== undefined && status !== 'running') {
      safeRemove('session', SYNC_KEY);
      if (lastStatus.current === 'running') repos.reload();
    }
    lastStatus.current = status;
  }, [job.data]);

  // 404: the server restarted and forgot the id. Fall back to GET /repos' last record.
  useEffect(() => {
    if (job.error instanceof ApiError && job.error.status === 404) {
      setActive(null);
      setLostNotice(true);
      repos.reload();
    }
  }, [job.error]);

  // Keyed on the data object, which is new after every fetch, so a stale answer cannot clear a fresh 409.
  useEffect(() => {
    if (repos.data !== undefined && !repos.data.sync.running) setWaitingForOther(false);
  }, [repos.data]);

  const startSync = async (repo?: string) => {
    setStarting(true);
    setStartError(undefined);
    setLostNotice(false);
    try {
      const res = await startRepoSync(repo);
      setActive(res.sync_id);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        if (err.body.sync_id !== undefined) setActive(err.body.sync_id);
        else {
          setWaitingForOther(true);
          repos.reload();
        }
      } else setStartError(err);
    } finally {
      setStarting(false);
    }
  };

  const entityMap = useMemo(() => entitiesByRepo(services.data?.repos), [services.data]);
  const rows = useMemo(() => filterRepos(repos.data?.repos ?? [], filter, entityMap), [repos.data, filter, entityMap]);

  // job.data is briefly null or undefined right after the id changes; count that as running.
  const ownRunning = activeId !== null && (job.data == null ? job.error === undefined : job.data.status === 'running');
  ownRunningRef.current = ownRunning;
  const otherRunning = !ownRunning && (waitingForOther || repos.data?.sync.running === true);
  const locked = starting || ownRunning || otherRunning;
  const finished = job.data !== undefined && job.data !== null && job.data.status !== 'running' ? job.data : undefined;

  return (
    <>
      <PageHeader
        title="Repos"
        description="The checkouts the code tools read, from resources/repos.json. A sync clones missing repos, moves clean ones to their pinned branch and refreshes the codegraph index. Checkouts with local changes are left alone."
        actions={
          <Button variant="primary" icon="refresh" busy={starting} disabled={locked || repos.data?.not_configured !== undefined} onClick={() => void startSync()}>
            {ownRunning || otherRunning ? 'Sync running…' : 'Sync all'}
          </Button>
        }
      />

      {startError !== undefined && <ErrorNotice title="Could not start the sync" error={startError} />}
      {lostNotice && (
        <Notice variant="info" title="That sync is no longer known to the server">
          The server keeps sync ids in memory and has probably restarted. The cards below show the last sync record.
        </Notice>
      )}
      {job.error !== undefined && !(job.error instanceof ApiError && job.error.status === 404) && (
        <ErrorNotice title="Could not check the sync" error={job.error} onRetry={job.reload} />
      )}

      {ownRunning && <RunningPanel job={job.data ?? null} syncId={activeId} />}
      {otherRunning && (
        <Notice variant="info" title="A sync is already running.">
          Sync buttons are off until it finishes. This page checks again every {OTHER_POLL_MS / 1000} seconds.
        </Notice>
      )}
      {finished !== undefined && <FinishedPanel job={finished} onDismiss={() => setActive(null)} />}

      {repos.loading && repos.data === undefined && repos.error === undefined && <Loading label="Loading repos…" />}
      {repos.error !== undefined && repos.data === undefined && <ErrorNotice error={repos.error} onRetry={repos.reload} />}
      {repos.data !== undefined && (
        <>
          {repos.data.not_configured !== undefined && (
            <Notice variant="warn" title={<span className="mono">{repos.data.not_configured.key}</span>}>
              {repos.data.not_configured.message}
            </Notice>
          )}
          <SummaryCards data={repos.data} />
          <Filters filter={filter} onChange={setFilter} entityFilterOff={entityMap === undefined} />
          <ReposTable
            rows={rows}
            total={repos.data.repos.length}
            entityMap={entityMap}
            locked={locked}
            onSync={(repo) => void startSync(repo)}
            onClearFilters={() => setFilter({ q: '', entity: 'All', state: 'All' })}
          />
        </>
      )}
    </>
  );
}

// ------------------------------------------------------------------ summary

function Card({ label, value, detail }: { label: string; value: ReactNode; detail?: ReactNode }) {
  return (
    <div style={{ flex: '1 1 200px', minWidth: 0, padding: '14px 16px', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--radius-lg)' }}>
      <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted)' }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 600, margin: '4px 0 2px' }}>{value}</div>
      {detail !== undefined && detail !== '' && <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.45 }}>{detail}</div>}
    </div>
  );
}

function SummaryCards({ data }: { data: ReposResponse }) {
  const { sync } = data;
  const last = sync.last;
  const next = sync.next_at !== undefined ? formatDateTime(sync.next_at) : sync.due ? 'Due now' : '—';
  const every = `Every ${formatDuration(sync.interval_ms)} (TRIAGE_REPOS_SYNC_INTERVAL)`;
  return (
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
      <Card
        label="Last sync"
        value={last !== null ? formatDateTime(last.last_attempt_at) : 'Never'}
        detail={last !== null ? `Started from ${triggerLabel(last.trigger)}` : 'No sync has run yet'}
      />
      <Card
        label="Result"
        value={last !== null ? countsLine(last.ok.length, last.skipped.length, last.failed.length) : '—'}
        detail={last !== null ? problemNames(last) : undefined}
      />
      <Card label="Next sync due" value={next} detail={every} />
      <Card
        label="Auto-sync"
        value={sync.timer.on ? 'Timer on' : 'Timer off'}
        detail={
          <>
            {!sync.timer.on && <div>{sync.timer.reason}</div>}
            {sync.interfaces.length > 0 && <div>Also before runs from {sync.interfaces.join(', ')}</div>}
          </>
        }
      />
    </div>
  );
}

// ------------------------------------------------------------------ filters

function Filters({ filter, onChange, entityFilterOff }: { filter: RepoFilter; onChange: (f: RepoFilter) => void; entityFilterOff: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
      <div style={{ flex: '1 1 260px', minWidth: 0 }}>
        <Label htmlFor="repo-q">Search</Label>
        <div style={{ position: 'relative' }}>
          <span style={{ position: 'absolute', left: 12, top: 12, color: 'var(--muted)', display: 'flex' }}>
            <Icon name="search" />
          </span>
          <Input
            id="repo-q"
            type="search"
            placeholder="Repo name"
            value={filter.q}
            onChange={(e) => onChange({ ...filter, q: e.target.value })}
            style={{ paddingLeft: 36 }}
          />
        </div>
      </div>
      <div style={{ width: 180 }}>
        <Label htmlFor="repo-entity">Entity</Label>
        <Select
          id="repo-entity"
          value={filter.entity}
          disabled={entityFilterOff}
          title={entityFilterOff ? 'Entities could not be loaded' : undefined}
          onChange={(e) => onChange({ ...filter, entity: e.target.value as Entity | 'All' })}
        >
          <option value="All">All</option>
          {ENTITIES.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </Select>
      </div>
      <div style={{ width: 200 }}>
        <Label htmlFor="repo-state">State</Label>
        <Select id="repo-state" value={filter.state} onChange={(e) => onChange({ ...filter, state: e.target.value as RepoState })}>
          {REPO_STATES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ table

const dash = <span className="faint">—</span>;

function ReposTable(props: {
  rows: RepoStatusRow[];
  total: number;
  entityMap: ReadonlyMap<string, readonly Entity[]> | undefined;
  locked: boolean;
  onSync: (repo: string) => void;
  onClearFilters: () => void;
}) {
  const { rows, total, entityMap, locked, onSync, onClearFilters } = props;
  if (total === 0) {
    return (
      <Panel>
        <EmptyState icon="repos" title="No repos configured">
          resources/repos.json lists no repos yet.
        </EmptyState>
      </Panel>
    );
  }
  return (
    <Panel padded={false}>
      {rows.length === 0 ? (
        <EmptyState title="No repos match" actions={<Button size="sm" onClick={onClearFilters}>Clear filters</Button>}>
          Try a different search or state.
        </EmptyState>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Repo</th>
                <th scope="col">Entities</th>
                <th scope="col">Branch</th>
                <th scope="col">Commit</th>
                <th scope="col">Working tree</th>
                <th scope="col">Codegraph</th>
                <th scope="col" style={{ textAlign: 'right' }}>
                  Action
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <RepoRow key={row.repo} row={row} entities={entityMap?.get(row.repo)} locked={locked} onSync={onSync} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ padding: 12, fontSize: 13, color: 'var(--muted)', borderTop: '1px solid var(--line-soft)' }}>
        {rows.length} of {total} shown
      </div>
    </Panel>
  );
}

function RepoRow({ row, entities, locked, onSync }: { row: RepoStatusRow; entities: readonly Entity[] | undefined; locked: boolean; onSync: (repo: string) => void }) {
  const commit = shortCommit(row.commit);
  return (
    <tr>
      <td className="mono" style={{ fontWeight: 500 }}>
        {row.repo}
        {row.problem !== undefined && (
          <div className="hint" style={{ fontFamily: 'var(--font-sans)', fontWeight: 400 }}>
            {row.problem}
          </div>
        )}
      </td>
      <td style={{ fontSize: 13 }}>{entities !== undefined && entities.length > 0 ? entities.join(' · ') : dash}</td>
      <td>
        {row.expectedBranch === null ? (
          dash
        ) : row.drift === true ? (
          <span style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
            <span className="mono" style={{ fontSize: 13 }}>
              {row.expectedBranch}
            </span>
            <span className="muted">→</span>
            <span className="mono" style={{ fontSize: 13 }}>
              {row.actualBranch ?? '(detached)'}
            </span>
            <StatusTag tone="amber" icon="alert">
              drift
            </StatusTag>
          </span>
        ) : (
          <span className="mono" style={{ fontSize: 13 }}>
            {row.expectedBranch}
          </span>
        )}
      </td>
      <td className="mono" style={{ fontSize: 13 }} title={row.commit ?? undefined}>
        {commit ?? dash}
      </td>
      <td>
        {!row.present ? (
          <StatusTag tone="muted" icon={null}>
            not cloned
          </StatusTag>
        ) : row.dirty === true ? (
          <StatusTag tone="amber" icon="alert">
            local changes
          </StatusTag>
        ) : row.dirty === false ? (
          <StatusTag tone="neutral" icon="check">
            clean
          </StatusTag>
        ) : (
          dash
        )}
      </td>
      <td>
        {row.indexed ? (
          <StatusTag tone="neutral" icon="check">
            indexed
          </StatusTag>
        ) : row.present ? (
          <StatusTag tone="amber" icon="alert">
            not indexed
          </StatusTag>
        ) : (
          <StatusTag tone="muted" icon={null}>
            not indexed
          </StatusTag>
        )}
      </td>
      <td style={{ textAlign: 'right' }}>
        <Button size="sm" disabled={locked} onClick={() => onSync(row.repo)} aria-label={`${row.present ? 'Sync' : 'Clone'} ${row.repo}`}>
          {row.present ? 'Sync' : 'Clone'}
        </Button>
      </td>
    </tr>
  );
}

// ------------------------------------------------------------------ sync panels

function RunningPanel({ job, syncId }: { job: SyncJob | null; syncId: string | null }) {
  return (
    <>
      <Panel style={{ padding: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ color: 'var(--tone-info-fg)', display: 'flex' }}>
                <Icon name="spinner" className="spin" />
              </span>
              <h2 style={{ fontSize: 16, fontWeight: 600 }}>Sync running</h2>
            </div>
            <p className="hint" style={{ margin: '4px 0 0' }}>
              {job?.repo ?? 'All repos'}
              {job !== null && <> · started {formatDateTime(job.started_at)}</>}
              {syncId !== null && (
                <>
                  {' '}
                  · sync id <span className="mono" title={syncId}>{shortRunId(syncId)}</span>
                </>
              )}
            </p>
          </div>
          <div className="hint" style={{ margin: 0, maxWidth: 320, textAlign: 'right' }}>
            The server reports per-repo results when the whole sync finishes.
          </div>
        </div>
      </Panel>
      <Notice variant="info" title="Only one sync at a time">
        Sync buttons are off until this one finishes. The sync id lives in the server's memory, so after a restart this page falls back to the last sync record.
      </Notice>
    </>
  );
}

function FinishedPanel({ job, onDismiss }: { job: SyncJob; onDismiss: () => void }) {
  const dismiss = (
    <Button size="sm" variant="ghost" onClick={onDismiss}>
      Dismiss
    </Button>
  );
  if (job.status === 'busy') {
    return (
      <Notice variant="warn" title="The sync did not run" actions={dismiss}>
        {job.reason ?? 'Another process is syncing the repos.'}
      </Notice>
    );
  }
  const results = job.results ?? [];
  const ok = job.ok?.length ?? results.filter((r) => r.status === 'ok').length;
  const skipped = job.skipped?.length ?? results.filter((r) => r.status === 'skipped').length;
  const failed = job.failed?.length ?? results.filter((r) => r.status === 'failed').length;
  const when = job.finished_at !== undefined ? ` · finished ${formatDateTime(job.finished_at)}` : '';
  return (
    <>
      {job.status === 'failed' && (
        <Notice variant="error" title="The sync failed">
          {job.reason ?? 'No reason was given.'}
        </Notice>
      )}
      <Panel
        padded={false}
        title={job.status === 'failed' ? 'Sync results' : 'Sync finished'}
        description={`${job.repo ?? 'All repos'}${when} · ${countsLine(ok, skipped, failed)}`}
        actions={dismiss}
      >
        {results.length === 0 ? (
          <p className="hint" style={{ margin: 0, padding: '0 16px 16px' }}>
            No per-repo results were reported.
          </p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col" style={{ width: 200 }}>
                  Repo
                </th>
                <th scope="col" style={{ width: 120 }}>
                  Status
                </th>
                <th scope="col">Result</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.repo}>
                  <td className="mono" style={{ fontWeight: 500 }}>
                    {r.repo}
                  </td>
                  <td>
                    <StatusTag look={syncResultTone(r.status)}>{r.status}</StatusTag>
                  </td>
                  <td style={{ fontSize: 13, color: 'var(--text-2)' }}>
                    {r.line}
                    {r.warnings.map((w, i) => (
                      <div key={i} className="hint" style={{ margin: '2px 0 0' }}>
                        {w}
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}
