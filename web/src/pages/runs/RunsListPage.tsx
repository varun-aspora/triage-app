import { type FormEvent, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { listRuns } from '../../api/endpoints.ts';
import type { Category, FeedbackVerdict, ListRunsQuery, RunStatus } from '../../api/types.ts';
import { Button, LinkButton } from '../../components/Button.tsx';
import { EmptyState } from '../../components/EmptyState.tsx';
import { Input, Label, Select } from '../../components/Field.tsx';
import { Icon } from '../../components/Icon.tsx';
import { ErrorNotice, Loading } from '../../components/LoadState.tsx';
import { PageHeader } from '../../components/PageHeader.tsx';
import { Panel } from '../../components/Panel.tsx';
import { StatusTag } from '../../components/StatusTag.tsx';
import { CATEGORIES, FEEDBACK_VERDICTS, RUN_STATUSES } from '../../lib/constants.ts';
import { formatDateTime, shortRunId } from '../../lib/format.ts';
import { runPhaseTone } from '../../lib/status.ts';
import { useApi } from '../../lib/useApi.ts';
import { CREATED_RANGES, DEFAULT_CREATED, isCreatedRange, listCost, sinceFor } from './run-logic.ts';
import './runs.css';

const PAGE_SIZE = 50;

const Dash = () => <span className="faint">—</span>;

function pick<T extends string>(value: string | null, allowed: readonly T[]): T | undefined {
  return allowed.includes(value as T) ? (value as T) : undefined;
}

export default function RunsListPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const status = pick<RunStatus>(params.get('phase'), RUN_STATUSES);
  const category = pick<Category>(params.get('category'), CATEGORIES);
  const feedback = pick<FeedbackVerdict | 'none'>(params.get('feedback'), [...FEEDBACK_VERDICTS, 'none']);
  const createdParam = params.get('created');
  const created = isCreatedRange(createdParam) ? createdParam : DEFAULT_CREATED;
  const filterKey = `${status}|${category}|${feedback}|${created}`;

  // Paging state belongs to one set of filters; a new filter starts again at the newest page.
  const [paging, setPaging] = useState<{ key: string; stack: string[] }>({ key: filterKey, stack: [] });
  const stack = paging.key === filterKey ? paging.stack : [];
  const cursor = stack[stack.length - 1];

  // Fixed per filter set, so paging and re-renders do not move the window.
  const since = useMemo(() => sinceFor(created, Date.now()), [filterKey]);

  const query: ListRunsQuery = {
    status,
    category,
    feedback,
    since,
    cursor,
    limit: PAGE_SIZE,
  };
  const { data, error, loading, reload } = useApi((signal) => listRuns(query, { signal }), [filterKey, cursor, since]);

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value === '') next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const [runIdInput, setRunIdInput] = useState('');
  const openRun = (e: FormEvent) => {
    e.preventDefault();
    const id = runIdInput.trim();
    if (id !== '') navigate(`/runs/${encodeURIComponent(id)}`);
  };

  const filtered = status !== undefined || category !== undefined || feedback !== undefined || created !== 'any';
  // The default range is a filter too, so an empty page cannot tell 'no runs
  // at all' from 'none in range' on its own. One unfiltered row settles it.
  const emptyFiltered = filtered && data !== undefined && data.runs.length === 0 && stack.length === 0;
  const anyRun = useApi(
    (signal) => (emptyFiltered ? listRuns({ limit: 1 }, { signal }).then((r) => r.runs.length > 0) : Promise.resolve(true)),
    [emptyFiltered, filterKey],
  );
  const noRunsAtAll = !filtered || (emptyFiltered && anyRun.data === false);
  const probing = emptyFiltered && anyRun.loading;

  return (
    <>
      <PageHeader
        title="Runs"
        description="Every triage run, newest first. Open one to read the report, ask a follow-up or leave feedback."
        actions={
          <LinkButton to="/runs/new" variant="primary" icon="plus">
            New run
          </LinkButton>
        }
      />

      <div className="runs-filters">
        <form onSubmit={openRun} style={{ width: 320, maxWidth: '100%' }} role="search">
          <Label htmlFor="runs-q">Run id</Label>
          <div style={{ position: 'relative' }}>
            <span style={{ position: 'absolute', left: 12, top: 12, color: 'var(--muted)', display: 'flex' }}>
              <Icon name="search" />
            </span>
            <Input
              id="runs-q"
              type="search"
              className="mono"
              placeholder="Paste a run id"
              value={runIdInput}
              onChange={(e) => setRunIdInput(e.target.value)}
              style={{ paddingLeft: 36 }}
            />
          </div>
        </form>
        <div style={{ width: 150 }}>
          <Label htmlFor="runs-phase">Phase</Label>
          <Select id="runs-phase" value={status ?? ''} onChange={(e) => setFilter('phase', e.target.value)}>
            <option value="">All</option>
            {RUN_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </div>
        <div style={{ width: 180 }}>
          <Label htmlFor="runs-cat">Category</Label>
          <Select id="runs-cat" value={category ?? ''} onChange={(e) => setFilter('category', e.target.value)}>
            <option value="">All</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </div>
        <div style={{ width: 160 }}>
          <Label htmlFor="runs-since">Created</Label>
          <Select
            id="runs-since"
            value={created}
            onChange={(e) => setFilter('created', e.target.value === DEFAULT_CREATED ? '' : e.target.value)}
          >
            {CREATED_RANGES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </Select>
        </div>
        <div style={{ width: 150 }}>
          <Label htmlFor="runs-fb">Feedback</Label>
          <Select id="runs-fb" value={feedback ?? ''} onChange={(e) => setFilter('feedback', e.target.value)}>
            <option value="">Any</option>
            {FEEDBACK_VERDICTS.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
            <option value="none">none yet</option>
          </Select>
        </div>
      </div>

      {error !== undefined && <ErrorNotice error={error} onRetry={reload} title="Could not load runs" />}

      {data === undefined ? (
        loading && error === undefined ? (
          <Panel padded={false}>
            <Loading label="Loading runs…" />
          </Panel>
        ) : null
      ) : data.runs.length === 0 && stack.length === 0 ? (
        <Panel padded={false}>
          {probing ? (
            <Loading label="Loading runs…" />
          ) : !noRunsAtAll ? (
            <EmptyState title="No runs match these filters">Try a longer time range or clear a filter.</EmptyState>
          ) : (
            <EmptyState
              title="No runs yet"
              actions={
                <LinkButton to="/runs/new" variant="primary" icon="plus">
                  New run
                </LinkButton>
              }
            >
              Start one from a Slack thread or pasted messages.
            </EmptyState>
          )}
        </Panel>
      ) : (
        <Panel padded={false}>
          <div className="runs-table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Run</th>
                  <th scope="col">Created</th>
                  <th scope="col">Phase</th>
                  <th scope="col">Category</th>
                  <th scope="col">Tier</th>
                  <th scope="col">Report status</th>
                  <th scope="col" className="num">
                    Asks
                  </th>
                  <th scope="col">Feedback</th>
                  <th scope="col" className="num">
                    Cost
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.runs.map((r) => {
                  const cost = listCost(r);
                  return (
                    <tr key={r.run_id}>
                      <td>
                        <Link to={`/runs/${encodeURIComponent(r.run_id)}`} className="link mono" style={{ fontSize: 13 }} title={r.run_id}>
                          {shortRunId(r.run_id)}
                        </Link>
                      </td>
                      <td style={{ whiteSpace: 'nowrap', color: 'var(--text-2)' }}>{formatDateTime(r.created_at)}</td>
                      <td>
                        <StatusTag look={runPhaseTone(r.phase)}>{r.phase}</StatusTag>
                      </td>
                      <td className="mono" style={{ fontSize: 13 }}>
                        {r.category ?? <Dash />}
                      </td>
                      <td>{r.tier_final ?? <Dash />}</td>
                      <td className="mono" style={{ fontSize: 13 }}>
                        {r.report_status ?? <Dash />}
                      </td>
                      <td className="num">{r.submissions}</td>
                      <td>{r.feedback_verdict ?? <Dash />}</td>
                      <td className="num" style={{ whiteSpace: 'nowrap' }}>
                        {cost.text === '—' ? <Dash /> : cost.text}
                        {cost.live && (
                          <span className="muted" style={{ fontSize: 12 }} title="Still running: the total grows until it finishes">
                            {' '}
                            live
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {data.runs.length === 0 && (
                  <tr>
                    <td colSpan={9} className="muted">
                      No older runs.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="runs-footer">
            <span>
              {stack.length === 0 ? 'Newest runs' : `Page ${stack.length + 1}`}
              {loading ? ' · loading…' : ''}
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              <Button
                size="sm"
                disabled={stack.length === 0}
                onClick={() => setPaging({ key: filterKey, stack: stack.slice(0, -1) })}
              >
                Newer
              </Button>
              <Button
                size="sm"
                disabled={data.next_cursor === null}
                onClick={() => data.next_cursor !== null && setPaging({ key: filterKey, stack: [...stack, data.next_cursor] })}
              >
                Older
              </Button>
            </div>
          </div>
        </Panel>
      )}
    </>
  );
}
