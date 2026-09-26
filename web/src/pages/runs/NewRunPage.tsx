import { type FormEvent, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { ApiError } from '../../api/client.ts';
import { startRun } from '../../api/endpoints.ts';
import type { Entity, KnownIdKey, Tier } from '../../api/types.ts';
import { useSession } from '../../app/session.ts';
import { Button, LinkButton } from '../../components/Button.tsx';
import { Field, FieldError, Input, Textarea } from '../../components/Field.tsx';
import { Icon } from '../../components/Icon.tsx';
import { describeError } from '../../components/LoadState.tsx';
import { Notice } from '../../components/Notice.tsx';
import { PageHeader } from '../../components/PageHeader.tsx';
import { Panel } from '../../components/Panel.tsx';
import { Segmented } from '../../components/Segmented.tsx';
import { ENTITY_LABELS, TIERS } from '../../lib/constants.ts';
import { KNOWN_ID_FIELDS, KNOWN_ID_KEYS, knownIdField } from '../../lib/known-ids.ts';
import {
  buildStartBody,
  type FormField,
  formFieldOf,
  type IdRow,
  joinEntityLabels,
  MAX_CONTEXT,
  newIdempotencyKey,
} from './run-logic.ts';
import { useRememberedName } from './remembered-name.ts';
import './runs.css';

const STEPS: readonly [string, string][] = [
  ['preflight', 'Checks the tools and credentials the run needs'],
  ['identity', "Resolves the customer's ID chain"],
  ['classifying', 'Picks the category and the model tier'],
  ['dispatched', 'Hands off to the Triage agent'],
  ['investigating', 'Per-entity investigators and the code walker run'],
  ['completed', 'Report ready as JSON and Markdown'],
];

type Errors = Partial<Record<FormField, string>>;

let rowSeq = 0;
type KeyedRow = IdRow & { id: number };
const newRow = (key: KnownIdKey): KeyedRow => ({ id: ++rowSeq, key, value: '' });
// The key the first row starts on. The form used to start on user_id, which
// D69 renamed aspora_user_id. The keys offered come from known-ids.json.
const FIRST_ID_KEY: KnownIdKey = 'aspora_user_id';

export default function NewRunPage() {
  const { session } = useSession();
  const navigate = useNavigate();

  const [source, setSource] = useState<'slack' | 'paste'>('slack');
  const [slackUrl, setSlackUrl] = useState('');
  const [pasted, setPasted] = useState('');
  const [context, setContext] = useState('');
  const [requestedBy, setRequestedBy] = useRememberedName();
  const [entitiesMode, setEntitiesMode] = useState<'auto' | 'choose'>('auto');
  const [entities, setEntities] = useState<Entity[]>([]);
  const [tierMode, setTierMode] = useState<'auto' | 'choose'>('auto');
  const [tier, setTier] = useState<Tier>('mid');
  const [ids, setIds] = useState<KeyedRow[]>(() => [newRow(FIRST_ID_KEY)]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<{ variant: 'warn' | 'error'; title: string; text: string } | null>(null);
  const [pending, setPending] = useState(false);
  // One key per submission: a retry or a double click of the same submission
  // reuses it, so the server returns the run it already started.
  const idemKey = useRef(newIdempotencyKey());
  const inFlight = useRef(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (inFlight.current) return;
    const built = buildStartBody(
      { source, slackUrl, pasted, context, requestedBy, entitiesMode, entities, tierMode, tier, ids, from, to },
      Date.now(),
    );
    if (!built.ok) {
      setErrors(built.errors);
      setFailure({ variant: 'error', title: 'Check the form', text: 'Some fields need attention before the run can start.' });
      return;
    }
    setErrors({});
    setFailure(null);
    inFlight.current = true;
    setPending(true);
    try {
      const res = await startRun(built.body, idemKey.current);
      idemKey.current = newIdempotencyKey();
      navigate(`/runs/${encodeURIComponent(res.run_id)}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) {
        setSource('paste');
        setErrors({ thread: 'Paste the thread messages here instead.' });
        setFailure({
          variant: 'warn',
          title: 'Could not read the Slack thread',
          // The server's hint is written for API callers (messages[]), so the form says it in its own words.
          text: `The server could not read that thread${err.body.code !== undefined ? ` (${err.body.code})` : ''}. Paste the messages below and start again.`,
        });
      } else if (err instanceof ApiError && err.status === 400) {
        const marked: Errors = {};
        for (const f of err.body.fields ?? []) {
          const section = formFieldOf(f);
          if (section !== undefined) marked[section] = `The server did not accept this${err.body.reason !== undefined ? `: ${err.body.reason}` : '.'}`;
        }
        setErrors(marked);
        setFailure({ variant: 'error', title: 'The server did not accept the request', text: describeError(err) });
      } else if (!(err instanceof ApiError && err.status === 401)) {
        setFailure({ variant: 'error', title: 'Could not start the run', text: `${describeError(err)} Trying again is safe.` });
      }
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  const toggleEntity = (entity: Entity, on: boolean) =>
    setEntities((cur) => (on ? [...cur.filter((x) => x !== entity), entity] : cur.filter((x) => x !== entity)));

  const addId = () => {
    const used = new Set(ids.map((r) => r.key));
    setIds([...ids, newRow(KNOWN_ID_KEYS.find((k) => !used.has(k)) ?? FIRST_ID_KEY)]);
  };

  return (
    <>
      <PageHeader
        title="New run"
        description="Start a triage run from a Slack thread or pasted messages."
        breadcrumb={[{ label: 'Runs', to: '/runs' }]}
      />
      <form className="runs-cols" onSubmit={submit} noValidate>
        <div className="runs-main">
          {failure !== null && (
            <Notice variant={failure.variant} title={failure.title}>
              {failure.text}
            </Notice>
          )}

          <Panel
            title="Thread"
            description="Send a Slack thread URL or pasted messages. If the Slack read fails, paste the messages instead. Additional context goes with either."
          >
            <div style={{ margin: '0 0 16px' }}>
              <Segmented
                label="Thread source"
                value={source}
                onChange={setSource}
                options={[
                  { value: 'slack', label: 'Slack thread URL' },
                  { value: 'paste', label: 'Paste messages' },
                ]}
              />
            </div>
            {source === 'slack' ? (
              <Field label="Slack thread URL" error={errors.thread}>
                <Input
                  className="mono"
                  type="url"
                  autoComplete="off"
                  placeholder="https://[workspace].slack.com/archives/[channel]/p[timestamp]"
                  value={slackUrl}
                  onChange={(e) => setSlackUrl(e.target.value)}
                />
              </Field>
            ) : (
              <Field
                label="Messages"
                hint="Paste the thread as text. It is sent as one message; the agent reads it the same way."
                error={errors.thread}
              >
                <Textarea rows={8} value={pasted} onChange={(e) => setPasted(e.target.value)} />
              </Field>
            )}
            <div style={{ margin: '16px 0 0' }}>
              <Field
                label="Additional context"
                optional
                hint="Anything the thread does not say: what you already checked, related tickets, customer details. Sent after the thread messages."
                error={errors.context}
              >
                <Textarea rows={4} maxLength={MAX_CONTEXT} value={context} onChange={(e) => setContext(e.target.value)} />
              </Field>
            </div>
          </Panel>

          <Panel title="Requested by">
            <Field label="Your name" hint="Recorded on the run and on any feedback." error={errors.requested_by}>
              <Input placeholder="[your name]" autoComplete="name" value={requestedBy} onChange={(e) => setRequestedBy(e.target.value)} />
            </Field>
          </Panel>

          <Panel title="Scope" description="Auto lets the triage agent decide. Switch a field to Choose to override it for this run.">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              <div role="group" aria-labelledby="nr-ent">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '0 0 10px' }}>
                  <span className="lbl" id="nr-ent" style={{ margin: 0 }}>
                    Entities
                  </span>
                  <Segmented label="Entities: auto or choose" value={entitiesMode} onChange={setEntitiesMode} options={AUTO_CHOOSE} />
                </div>
                {entitiesMode === 'auto' ? (
                  <div className="runs-auto-note">
                    <span>
                      <Icon name="info" />
                    </span>
                    <span>
                      The agent works out which entities the issue touches from the thread and the IDs it resolves. It can use any entity
                      enabled on this server: {joinEntityLabels(session.entities)}.
                    </span>
                  </div>
                ) : (
                  <>
                    <div className="runs-row">
                      {session.entities.map((ent) => (
                        <label key={ent} className="runs-pill">
                          <input type="checkbox" checked={entities.includes(ent)} onChange={(e) => toggleEntity(ent, e.target.checked)} />
                          {ENTITY_LABELS[ent]}
                        </label>
                      ))}
                    </div>
                    <p className="hint">Only the entities you tick are investigated.</p>
                  </>
                )}
                {errors.entities !== undefined && <FieldError>{errors.entities}</FieldError>}
              </div>

              <div role="group" aria-labelledby="nr-tier">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '0 0 10px' }}>
                  <span className="lbl" id="nr-tier" style={{ margin: 0 }}>
                    Model tier
                  </span>
                  <Segmented label="Model tier: auto or choose" value={tierMode} onChange={setTierMode} options={AUTO_CHOOSE} />
                </div>
                {tierMode === 'auto' ? (
                  <div className="runs-auto-note">
                    <span>
                      <Icon name="info" />
                    </span>
                    <span>
                      The classifier picks cheap, mid or strong once it has read the thread, using the tier policy. Hard or multi-entity cases
                      go to strong.
                    </span>
                  </div>
                ) : (
                  <>
                    <div className="runs-row" role="radiogroup" aria-label="Model tier">
                      {TIERS.map((t) => (
                        <label key={t} className="runs-pill">
                          <input type="radio" name="tier" checked={tier === t} onChange={() => setTier(t)} />
                          {t}
                        </label>
                      ))}
                    </div>
                    <p className="hint">Fixes the tier for this run and skips the tier policy.</p>
                  </>
                )}
                {errors.tier !== undefined && <FieldError>{errors.tier}</FieldError>}
              </div>

              <div>
                <span className="lbl">
                  Known IDs <span className="optional">(optional)</span>
                </span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {ids.map((row, i) => {
                    const field = knownIdField(row.key);
                    const setValue = (value: string) => setIds(ids.map((r, j) => (j === i ? { ...r, value } : r)));
                    return (
                      <div key={row.id}>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <select
                            className="field mono"
                            aria-label="ID type"
                            style={{ width: 200, flexShrink: 0 }}
                            value={row.key}
                            // A value typed for one key rarely fits another, and a
                            // choice field only takes its own options, so start over.
                            onChange={(e) =>
                              setIds(ids.map((r, j) => (j === i ? { ...r, key: e.target.value as KnownIdKey, value: '' } : r)))
                            }
                          >
                            {KNOWN_ID_FIELDS.map((f) => (
                              <option key={f.key} value={f.key} title={f.description}>
                                {f.key}
                              </option>
                            ))}
                          </select>
                          {field.options !== undefined ? (
                            <select
                              className="field"
                              aria-label={`${row.key} value`}
                              value={row.value}
                              onChange={(e) => setValue(e.target.value)}
                            >
                              <option value="">Not given</option>
                              {field.options.map((o) => (
                                <option key={o.value} value={o.value}>
                                  {o.value} ({o.description})
                                </option>
                              ))}
                            </select>
                          ) : (
                            <input
                              className="field mono"
                              aria-label={`${row.key} value`}
                              autoComplete="off"
                              value={row.value}
                              onChange={(e) => setValue(e.target.value)}
                            />
                          )}
                          <button
                            type="button"
                            className="runs-icon-btn"
                            aria-label={`Remove ${row.key}`}
                            onClick={() => setIds(ids.filter((_, j) => j !== i))}
                          >
                            ×
                          </button>
                        </div>
                        <p className="hint">{field.description}</p>
                      </div>
                    );
                  })}
                </div>
                <button type="button" className="runs-text-btn" style={{ margin: '10px 0 0' }} onClick={addId}>
                  <Icon name="plus" size={14} />
                  Add an ID
                </button>
                {errors.ids !== undefined && <FieldError>{errors.ids}</FieldError>}
              </div>

              <div>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  <Field label="Time window from" optional className="runs-grow" id="nr-from">
                    <Input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
                  </Field>
                  <Field label="to" className="runs-grow" id="nr-to">
                    <Input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
                  </Field>
                </div>
                <p className="hint">Your local time. Set both ends or leave both empty.</p>
                {errors.time_window !== undefined && <FieldError>{errors.time_window}</FieldError>}
              </div>
            </div>
          </Panel>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, paddingTop: 4 }}>
            <LinkButton to="/runs">Cancel</LinkButton>
            <Button type="submit" variant="primary" busy={pending}>
              Start triage
            </Button>
          </div>
        </div>

        <aside className="runs-side">
          <Panel title="What happens next" as="div">
            <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
              {STEPS.map(([phase, text], i) => (
                <li key={phase} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  <span
                    className="mono"
                    style={{
                      width: 22,
                      height: 22,
                      flexShrink: 0,
                      borderRadius: 11,
                      background: 'var(--tone-muted-bg)',
                      color: 'var(--muted)',
                      fontSize: 12,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {i + 1}
                  </span>
                  <div>
                    <div className="mono" style={{ fontSize: 13 }}>
                      {phase}
                    </div>
                    <div className="hint" style={{ margin: 0 }}>
                      {text}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
            <div style={{ height: 1, background: 'var(--line-soft)', margin: '16px 0' }} />
            <p style={{ margin: 0, fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5 }}>
              You land on the run page straight away and it updates as phases change. Submitting twice is safe: the form sends an idempotency
              key, so a second click returns the same run.
            </p>
          </Panel>
        </aside>
      </form>
    </>
  );
}

const AUTO_CHOOSE = [
  { value: 'auto', label: 'Auto' },
  { value: 'choose', label: 'Choose' },
] as const;
