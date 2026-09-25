// The run's event log: every pipeline step and every Flue event (model turns,
// tool calls, delegated tasks, messages), redacted like the rest of the run.
// It reads new lines every few seconds while the run is going; each row opens
// to the full stored event.

import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client.ts';
import { getRunEvents } from '../../api/endpoints.ts';
import type { RunEvent } from '../../api/types.ts';
import { describeError } from '../../components/LoadState.tsx';
import { Notice } from '../../components/Notice.tsx';
import { Panel } from '../../components/Panel.tsx';
import { Segmented } from '../../components/Segmented.tsx';
import { StatusTag } from '../../components/StatusTag.tsx';
import { appendEvents, isErrorEvent, matchesStepFilter, STEP_FILTERS, type StepFilter, summariseStep } from './verdict-logic.ts';

const POLL_MS = 3000;
const PAGE = 1000;

const FILTER_LABELS: Record<StepFilter, string> = { all: 'All', pipeline: 'Pipeline', model: 'Model', tools: 'Tools', errors: 'Errors' };

export function StepsPanel({ runId, live }: { runId: string; live: boolean }) {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [error, setError] = useState<unknown>(undefined);
  const [filter, setFilter] = useState<StepFilter>('all');
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const next = useRef(0);
  const liveRef = useRef(live);
  liveRef.current = live;

  useEffect(() => {
    setEvents([]);
    next.current = 0;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (): Promise<void> => {
      try {
        // Read every page there is, then wait for more while the run goes on.
        for (;;) {
          const page = await getRunEvents(runId, { after: next.current, limit: PAGE }, { signal: controller.signal });
          next.current = page.next;
          if (page.events.length > 0) setEvents((have) => appendEvents(have, page.events));
          if (!page.more) break;
        }
        setError(undefined);
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err);
        // Asking again gives the same answer.
        if (err instanceof ApiError && (err.status === 401 || err.status === 404)) return;
      }
      if (liveRef.current) timer = setTimeout(() => void load(), POLL_MS);
    };
    void load();
    return () => {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
    // A change of live starts over, so the lines written as the run settled are read once more.
  }, [runId, live]);

  const shown = events.filter((e) => matchesStepFilter(e, filter));
  const toggle = (i: number) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });

  return (
    <Panel
      title="Steps"
      description={`Every step the run took, oldest first: ${events.length} so far${live ? ', updating while the run goes on' : ''}. Values are masked like the rest of the run.`}
      actions={<Segmented label="Show" options={STEP_FILTERS.map((f) => ({ value: f, label: FILTER_LABELS[f] }))} value={filter} onChange={setFilter} />}
    >
      {error !== undefined && (
        <Notice variant="warn" title="Could not load the steps" style={{ marginBottom: 12 }}>
          {describeError(error)}
        </Notice>
      )}
      {shown.length === 0 ? (
        <p className="hint" style={{ margin: 0 }}>
          {events.length === 0 ? 'No steps logged yet.' : 'No steps match this filter.'}
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {shown.map((e) => (
            <div key={e.index} className="runs-entry" style={{ padding: '6px 0' }}>
              <button
                type="button"
                onClick={() => toggle(e.index)}
                aria-expanded={open.has(e.index)}
                style={{
                  display: 'flex',
                  gap: 10,
                  alignItems: 'baseline',
                  width: '100%',
                  textAlign: 'left',
                  background: 'none',
                  border: 0,
                  padding: 0,
                  cursor: 'pointer',
                  color: 'inherit',
                  font: 'inherit',
                }}
              >
                <span className="mono muted" style={{ fontSize: 12, minWidth: 92 }}>
                  {e.ts.length >= 23 ? e.ts.slice(11, 23) : e.ts}
                </span>
                <StatusTag tone={isErrorEvent(e) ? 'rust' : e.source === 'pipeline' ? 'info' : 'neutral'} icon={null}>
                  <span className="mono">{e.type}</span>
                </StatusTag>
                <span style={{ fontSize: 13, overflowWrap: 'anywhere', minWidth: 0 }}>{summariseStep(e)}</span>
              </button>
              {open.has(e.index) && (
                <pre className="mono" style={{ fontSize: 12, margin: '8px 0 0', padding: 12, background: 'var(--tone-muted-bg)', borderRadius: 8, overflow: 'auto', maxHeight: 480 }}>
                  {JSON.stringify(e.data, null, 2)}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
