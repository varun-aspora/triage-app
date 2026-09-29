// The run's event log: every pipeline step and every Flue event (model turns,
// tool calls, delegated tasks, messages), redacted like the rest of the run.
// It reads new lines every few seconds while the run is going; each row opens
// to the full stored event.

import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client.ts';
import { getRunEvents } from '../../api/endpoints.ts';
import type { RunEvent } from '../../api/types.ts';
import { Button } from '../../components/Button.tsx';
import { describeError } from '../../components/LoadState.tsx';
import { Notice } from '../../components/Notice.tsx';
import { Panel } from '../../components/Panel.tsx';
import { Segmented } from '../../components/Segmented.tsx';
import { StatusTag } from '../../components/StatusTag.tsx';
import { safeGet, safeSet } from '../../lib/storage.ts';
import {
  appendEvents,
  isErrorEvent,
  isStepOrder,
  STEP_FILTERS,
  STEP_ORDERS,
  type StepFilter,
  type StepOrder,
  summariseStep,
  visibleSteps,
} from './verdict-logic.ts';

const POLL_MS = 3000;
const PAGE = 1000;
// Remembered so someone watching live runs keeps newest first from run to run.
const ORDER_KEY = 'triage.steps.order';

const FILTER_LABELS: Record<StepFilter, string> = { all: 'All', pipeline: 'Pipeline', model: 'Model', tools: 'Tools', errors: 'Errors' };
const ORDER_LABELS: Record<StepOrder, string> = { asc: 'Oldest first', desc: 'Newest first' };

/** The run's events, read every page there is and kept fresh while the run goes on. */
export function useRunEvents(runId: string, live: boolean): { events: RunEvent[]; error: unknown } {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [error, setError] = useState<unknown>(undefined);
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

  return { events, error };
}

export function StepsPanel({ runId, live }: { runId: string; live: boolean }) {
  const { events, error } = useRunEvents(runId, live);
  return <StepsView events={events} error={error} live={live} />;
}

/** The running view keeps the log shut so the page stays short; the events are read either way, for the investigator rows. */
export function CollapsedSteps({ events, error, live }: { events: readonly RunEvent[]; error: unknown; live: boolean }) {
  const [shown, setShown] = useState(false);
  return (
    <>
      <Button size="sm" aria-expanded={shown} onClick={() => setShown((s) => !s)} style={{ alignSelf: 'flex-start' }}>
        {shown ? 'Hide steps' : 'Show steps'} ({events.length})
      </Button>
      {shown && <StepsView events={events} error={error} live={live} />}
    </>
  );
}

function StepsView({ events, error, live }: { events: readonly RunEvent[]; error: unknown; live: boolean }) {
  const [filter, setFilter] = useState<StepFilter>('all');
  const [order, setOrder] = useState<StepOrder>(() => {
    const saved = safeGet('local', ORDER_KEY);
    return isStepOrder(saved) ? saved : 'asc';
  });
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());

  const shown = visibleSteps(events, filter, order);
  const changeOrder = (o: StepOrder) => {
    setOrder(o);
    safeSet('local', ORDER_KEY, o);
  };
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
      description={`Every step the run took, ${ORDER_LABELS[order].toLowerCase()}: ${events.length} so far${live ? ', updating while the run goes on' : ''}. Values are masked like the rest of the run.`}
      actions={
        <>
          <Segmented label="Order" options={STEP_ORDERS.map((o) => ({ value: o, label: ORDER_LABELS[o] }))} value={order} onChange={changeOrder} />
          <Segmented label="Show" options={STEP_FILTERS.map((f) => ({ value: f, label: FILTER_LABELS[f] }))} value={filter} onChange={setFilter} />
        </>
      }
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
