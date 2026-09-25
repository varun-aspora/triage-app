import { type FormEvent, useState } from 'react';
import { useSearchParams } from 'react-router';
import { addService, listGuides, listServices } from '../../api/endpoints.ts';
import type { AddServiceBody, AddServiceResponse, Entity, ServicesResponse } from '../../api/types.ts';
import { Button, LinkButton } from '../../components/Button.tsx';
import { Field, Input, Select, Textarea } from '../../components/Field.tsx';
import { ErrorNotice, Loading } from '../../components/LoadState.tsx';
import { Notice } from '../../components/Notice.tsx';
import { PageHeader } from '../../components/PageHeader.tsx';
import { Segmented } from '../../components/Segmented.tsx';
import { Panel } from '../../components/Panel.tsx';
import { StatusTag } from '../../components/StatusTag.tsx';
import { useApi } from '../../lib/useApi.ts';
import {
  DESCRIPTION_MAX,
  NOTE_MAX,
  type ServiceDraft,
  type SubmitErrors,
  entityLabel,
  envKeyProblem,
  guideName,
  knownEnvState,
  leftoverErrors,
  logServiceProblem,
  oneLine,
  registryEntryPreview,
  renderFrontMatter,
  repoPinAfter,
  repoPinLine,
  serviceKeyProblem,
  submitErrors,
  suggestApiEnv,
  suggestDbEnv,
} from './catalog.ts';
import { type CheckLine, CheckList, CodePreview, FormLayout } from './parts.tsx';

const CRUMBS = [{ label: 'Services', to: '/services' }];
const DESCRIPTION = 'Register a service for an entity so its investigator can query it.';
const GROW = { flex: '1 1 240px', minWidth: 0 } as const;
const FIELDS = ['entity', 'key', 'repo', 'quickwit_service', 'db_env', 'api_env', 'note', 'guide_description'] as const;

export default function AddServicePage() {
  const services = useApi((signal) => listServices({ signal }), []);
  const [done, setDone] = useState<AddServiceResponse | null>(null);

  const header = <PageHeader title="Add service" description={DESCRIPTION} breadcrumb={CRUMBS} />;

  if (done !== null) return <>{header}<Saved result={done} onAnother={() => { setDone(null); services.reload(); }} /></>;
  if (services.loading) return <>{header}<Loading /></>;
  if (services.data === undefined) return <>{header}<ErrorNotice error={services.error} onRetry={services.reload} /></>;
  if (services.data.entities.length === 0) {
    return <>{header}<Notice variant="warn">No entities are enabled, so there is nothing to add a service to.</Notice></>;
  }
  return <>{header}<AddServiceForm data={services.data} onSaved={setDone} /></>;
}

function AddServiceForm({ data, onSaved }: { data: ServicesResponse; onSaved: (r: AddServiceResponse) => void }) {
  const [params] = useSearchParams();
  // The guide-name check is a convenience; the server checks again, so a failed load only hides it.
  const guides = useApi((signal) => listGuides({ signal }), []);
  const enabled = data.entities.map((g) => g.entity);
  const initialEntity = enabled.find((e) => e === params.get('entity')) ?? enabled[0]!;

  const [entity, setEntity] = useState<Entity>(initialEntity);
  const [key, setKey] = useState(params.get('key') ?? '');
  const [repo, setRepo] = useState('');
  const [logService, setLogService] = useState('');
  // Follows entity and key until the operator edits it.
  const [dbEnv, setDbEnv] = useState<string | null>(null);
  const [apiEnv, setApiEnv] = useState('');
  const [note, setNote] = useState('');
  const [createGuide, setCreateGuide] = useState(true);
  const [guideDescription, setGuideDescription] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [serverErrors, setServerErrors] = useState<SubmitErrors>({ fields: {}, form: null });
  const [busy, setBusy] = useState(false);

  const E = entityLabel(entity);
  const db = dbEnv ?? suggestDbEnv(entity, key);
  const existingKeys = data.entities.find((g) => g.entity === entity)?.services.map((s) => s.key) ?? [];
  const pin = data.repos.find((r) => r.repo === repo);
  const pinAfter = repoPinAfter(pin, entity);
  const name = guideName('service', entity, key);
  const guideTaken = guides.data?.guides.some((g) => g.name === name) ?? false;

  const local: Partial<Record<(typeof FIELDS)[number], string>> = {};
  const keyProblem = serviceKeyProblem(key, entity, existingKeys);
  if (keyProblem !== null) local.key = keyProblem;
  if (repo === '') local.repo = 'Choose a repo.';
  const lp = logServiceProblem(logService.trim());
  if (lp !== null) local.quickwit_service = lp;
  const dp = envKeyProblem(db.trim(), entity);
  if (dp !== null) local.db_env = dp;
  const ap = envKeyProblem(apiEnv.trim(), entity);
  if (ap !== null) local.api_env = ap;
  if (oneLine(note.trim()).length > NOTE_MAX) local.note = `At most ${NOTE_MAX} characters.`;
  if (createGuide && oneLine(guideDescription.trim()).length > DESCRIPTION_MAX) local.guide_description = `At most ${DESCRIPTION_MAX} characters.`;

  // Key problems show as the operator types; the rest wait for the first save so an empty form is not all red.
  const errorFor = (field: (typeof FIELDS)[number]): string | undefined =>
    serverErrors.fields[field] ?? (field === 'key' && key !== '' ? local.key : undefined) ?? (attempted ? local[field] : undefined);

  const change = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setServerErrors({ fields: {}, form: null });
  };

  const draft: ServiceDraft = {
    entity,
    key,
    repo: repo || '<repo>',
    quickwit_service: logService.trim(),
    db_env: db.trim(),
    api_env: apiEnv.trim(),
    note,
  };

  const checks: CheckLine[] = [];
  if (key === '') checks.push({ state: 'warn', text: 'Enter a service key' });
  else if (keyProblem === null) checks.push({ state: 'ok', text: <>Key <span className="mono">{key}</span> is free in {E}</> });
  else checks.push({ state: 'fail', text: keyProblem });
  if (createGuide && key !== '' && keyProblem === null) {
    checks.push(
      guideTaken
        ? { state: 'fail', text: <>A guide named <span className="mono">{name}</span> already exists</> }
        : { state: 'ok', text: <>Guide name <span className="mono">{name}</span> is free</> },
    );
  }
  for (const envName of [db.trim(), apiEnv.trim()]) {
    if (envName === '' || envKeyProblem(envName, entity) !== null) continue;
    const state = knownEnvState(data.entities, envName);
    const n = <span className="mono">{envName}</span>;
    if (state === 'set') checks.push({ state: 'ok', text: <>{n} is set in the .env</> });
    else if (state === 'blank') checks.push({ state: 'warn', text: <>{n} is blank in the .env; the investigator skips it until it is set</> });
    else if (state === 'missing') checks.push({ state: 'fail', text: <>{n} is not in the .env; add it first (a blank value is fine)</> });
    else checks.push({ state: 'warn', text: <>{n} must already be in the .env (a blank value is fine). The server checks when you save</> });
  }

  const files = 1 + (pinAfter !== null ? 1 : 0) + (createGuide ? 1 : 0);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setAttempted(true);
    if (Object.keys(local).length > 0 || (createGuide && guideTaken)) return;
    const body: AddServiceBody = { entity, key, repo, create_guide: createGuide };
    if (logService.trim() !== '') body.quickwit_service = logService.trim();
    if (db.trim() !== '') body.db_env = db.trim();
    if (apiEnv.trim() !== '') body.api_env = apiEnv.trim();
    if (note.trim() !== '') body.note = oneLine(note.trim());
    if (createGuide && guideDescription.trim() !== '') body.guide_description = oneLine(guideDescription.trim());
    setBusy(true);
    try {
      onSaved(await addService(body));
    } catch (err) {
      setServerErrors(
        submitErrors(err, (field, b) => {
          if (field !== 'key') return undefined;
          return b.error === 'guide exists'
            ? `A guide named ${name} already exists. Untick the stub guide or pick another key.`
            : `${E} already has a service with this key.`;
        }),
      );
    } finally {
      setBusy(false);
    }
  };

  const leftover = leftoverErrors(serverErrors, FIELDS);

  const main = (
    <form onSubmit={submit} noValidate style={{ display: 'contents' }}>
      <Panel title="Service">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <div style={{ flexShrink: 0 }}>
              <span className="lbl">Entity</span>
              <Segmented label="Entity" options={enabled.map((e) => ({ value: e, label: entityLabel(e) }))} value={entity} onChange={change(setEntity)} />
              {serverErrors.fields.entity !== undefined && <p className="field-error">{serverErrors.fields.entity}</p>}
            </div>
            <div style={GROW}>
              <Field label="Service key" hint={`Lowercase letters and digits. Must be unique within ${E}.`} error={errorFor('key')}>
                <Input className="mono" value={key} onChange={(e) => change(setKey)(e.target.value.trim())} autoComplete="off" spellCheck={false} maxLength={60} />
              </Field>
            </div>
          </div>
          <Field
            label="Repo"
            hint={`Repos from resources/repos.json. Picking one not yet pinned for ${E} adds ${E} to its entities.`}
            error={errorFor('repo')}
          >
            <Select className="mono" value={repo} onChange={(e) => change(setRepo)(e.target.value)}>
              <option value="">Choose a repo</option>
              {data.repos.map((r) => (
                <option key={r.repo} value={r.repo}>
                  {r.repo}
                  {r.entities.includes(entity) ? '' : ` (adds ${E})`}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Log service (Quickwit)" optional hint={`The value of the service field in the ${E} log index.`} error={errorFor('quickwit_service')}>
            <Input className="mono" value={logService} onChange={(e) => change(setLogService)(e.target.value)} autoComplete="off" spellCheck={false} />
          </Field>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <div style={GROW}>
              <Field
                label="Database env key"
                optional
                hint="Must already be in the .env; a blank value is fine. Leave empty if it has no database."
                error={errorFor('db_env')}
              >
                <Input className="mono" value={db} onChange={(e) => change(setDbEnv)(e.target.value.toUpperCase())} autoComplete="off" spellCheck={false} />
              </Field>
            </div>
            <div style={GROW}>
              <Field label="API env key" optional hint="Must already be in the .env; a blank value is fine." error={errorFor('api_env')}>
                <Input
                  className="mono"
                  value={apiEnv}
                  placeholder={suggestApiEnv(entity, key)}
                  onChange={(e) => change(setApiEnv)(e.target.value.toUpperCase())}
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
            </div>
          </div>
          <Field label="Note" optional hint="One line; line breaks become spaces. No customer data." error={errorFor('note')}>
            <Textarea rows={3} value={note} onChange={(e) => change(setNote)(e.target.value)} placeholder="What it does, and any caveat on deploy or log names" />
          </Field>
        </div>
      </Panel>
      <Panel title="Guide">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 14, lineHeight: 1.5, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={createGuide}
              onChange={(e) => change(setCreateGuide)(e.target.checked)}
              style={{ marginTop: 4, accentColor: 'var(--accent)' }}
            />
            <span>
              <span style={{ fontWeight: 500 }}>Create a stub guide </span>
              <span className="mono">{key !== '' ? name : `${entity}-<key>`}</span>
              <br />
              <span className="muted" style={{ fontSize: 13 }}>
                Every registry service needs a guide so the {E} investigator can load it. You can fill it in later from Guides.
              </span>
            </span>
          </label>
          {attempted && createGuide && guideTaken && (
            <p className="field-error" style={{ margin: 0 }}>
              A guide named {name} already exists. Untick this or pick another key.
            </p>
          )}
          {createGuide && (
            <Field
              label="Guide description"
              optional
              hint="What the note covers and when to use it, on one line. The only text the model sees before it opens the guide."
              error={errorFor('guide_description')}
            >
              <Input value={guideDescription} onChange={(e) => change(setGuideDescription)(e.target.value)} maxLength={DESCRIPTION_MAX} />
            </Field>
          )}
        </div>
      </Panel>
      {leftover !== null && <Notice variant="error" title="Not saved">{leftover}</Notice>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, paddingTop: 4 }}>
        <LinkButton to="/services">Cancel</LinkButton>
        <Button type="submit" variant="primary" busy={busy}>
          Add service
        </Button>
      </div>
    </form>
  );

  const side = (
    <Panel title="Changes" description={`${files} ${files === 1 ? 'file' : 'files'}, written straight to disk when you save.`} as="aside" style={{ padding: 20 }}>
      <CheckList items={checks} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <CodePreview label="Registry entry">{registryEntryPreview(draft)}</CodePreview>
        {pinAfter !== null && <CodePreview label="repos.json change">{`// resources/repos.json\n${repoPinLine(pinAfter)}`}</CodePreview>}
        {createGuide && (
          <CodePreview label="Guide front-matter">
            {`// knowledge/${key !== '' ? name : `${entity}-<key>`}/SKILL.md\n${renderFrontMatter({
              name: key !== '' ? name : `${entity}-<key>`,
              description: guideDescription,
              kind: 'service',
              entity,
              service: key || '<key>',
              status: 'stub',
            })}`}
          </CodePreview>
        )}
      </div>
      <p className="hint" style={{ margin: '12px 0 0' }}>
        The server reads the registry and guides once at boot, so the service is live after the server restarts.
      </p>
    </Panel>
  );

  return <FormLayout main={main} side={side} />;
}

function Saved({ result, onAnother }: { result: AddServiceResponse; onAnother: () => void }) {
  const E = entityLabel(result.entity);
  const guideFile = result.files.find((f) => f.path.startsWith('knowledge/'));
  const guide = guideName('service', result.entity, result.key);
  return (
    <Panel title={<>Service <span className="mono">{result.key}</span> added to {E}</>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {result.files.map((f) => (
            <li key={f.path} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <StatusTag tone={f.action === 'created' ? 'info' : 'neutral'} icon="check">
                {f.action}
              </StatusTag>
              <span className="mono" style={{ fontSize: 13 }}>
                {f.path}
              </span>
            </li>
          ))}
        </ul>
        {result.warnings.map((w, i) => (
          <Notice key={i} variant="warn">
            {w}
          </Notice>
        ))}
        <Notice variant="restart" title="Restart needed">
          Agents see this after the server restarts.
        </Notice>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <LinkButton to={`/services?entity=${result.entity}`} variant="primary">
            Back to services
          </LinkButton>
          {guideFile !== undefined && <LinkButton to={`/guides/${encodeURIComponent(guide)}`}>Open guide {guide}</LinkButton>}
          <Button variant="ghost" onClick={onAnother}>
            Add another
          </Button>
        </div>
      </div>
    </Panel>
  );
}
