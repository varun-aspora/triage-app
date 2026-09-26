import { type FormEvent, useState } from 'react';
import { useSearchParams } from 'react-router';
import { addGuide, listGuides, listServices } from '../../api/endpoints.ts';
import type { AddGuideBody, AddGuideResponse, Entity, GuideStatus, ServicesResponse } from '../../api/types.ts';
import { Button, LinkButton } from '../../components/Button.tsx';
import { Field, Input, Select, Textarea } from '../../components/Field.tsx';
import { ErrorNotice, Loading } from '../../components/LoadState.tsx';
import { Notice } from '../../components/Notice.tsx';
import { PageHeader } from '../../components/PageHeader.tsx';
import { Panel } from '../../components/Panel.tsx';
import { GUIDE_STATUSES } from '../../lib/constants.ts';
import { useApi } from '../../lib/useApi.ts';
import {
  BODY_MAX,
  DESCRIPTION_MAX,
  type GuideKind,
  SKILL_NAME_MAX,
  SKILL_NAME_RE,
  SOURCES_MAX,
  type SubmitErrors,
  defaultGuideBody,
  entityLabel,
  guideName,
  leftoverErrors,
  oneLine,
  renderSkillFile,
  servicesWithoutGuide,
  submitErrors,
} from './catalog.ts';
import { type CheckLine, CheckList, CodePreview, FormLayout } from './parts.tsx';

const CRUMBS = [{ label: 'Guides', to: '/guides' }];
const DESCRIPTION = 'Write a knowledge note for an entity or one of its services.';
const FIELDS = ['kind', 'entity', 'service', 'name', 'description', 'sources', 'status', 'body'] as const;
const STATUS_ORDER: readonly GuideStatus[] = ['stub', 'written', 'ported'];

export default function NewGuidePage() {
  const services = useApi((signal) => listServices({ signal }), []);
  const [done, setDone] = useState<{ result: AddGuideResponse; entity: Entity; kind: GuideKind } | null>(null);
  const header = <PageHeader title="New guide" description={DESCRIPTION} breadcrumb={CRUMBS} />;

  if (done !== null) return <>{header}<Saved {...done} /></>;
  if (services.loading) return <>{header}<Loading /></>;
  if (services.data === undefined) return <>{header}<ErrorNotice error={services.error} onRetry={services.reload} /></>;
  if (services.data.entities.length === 0) {
    return <>{header}<Notice variant="warn">No entities are enabled, so there is nothing to write a guide for.</Notice></>;
  }
  return <>{header}<NewGuideForm data={services.data} onSaved={(result, entity, kind) => setDone({ result, entity, kind })} /></>;
}

function NewGuideForm({ data, onSaved }: { data: ServicesResponse; onSaved: (r: AddGuideResponse, entity: Entity, kind: GuideKind) => void }) {
  const [params] = useSearchParams();
  // Only for the name-free check; the server refuses a duplicate anyway.
  const guides = useApi((signal) => listGuides({ signal }), []);
  const enabled = data.entities.map((g) => g.entity);

  const [kind, setKind] = useState<GuideKind>(params.get('kind') === 'overview' ? 'overview' : 'service');
  const [entity, setEntity] = useState<Entity>(enabled.find((e) => e === params.get('entity')) ?? enabled[0]!);
  const [pickedService, setPickedService] = useState(params.get('service') ?? '');
  const [description, setDescription] = useState('');
  const [sources, setSources] = useState('');
  const [status, setStatus] = useState<GuideStatus>('stub');
  // Follows kind, entity and service until the operator types in it.
  const [body, setBody] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [serverErrors, setServerErrors] = useState<SubmitErrors>({ fields: {}, form: null });
  const [busy, setBusy] = useState(false);

  const E = entityLabel(entity);
  const open = servicesWithoutGuide(data.entities, entity);
  const service = kind === 'service' ? (open.find((s) => s.key === pickedService) ?? open[0])?.key ?? '' : '';
  const repo = open.find((s) => s.key === service)?.repo ?? null;
  const name = guideName(kind, entity, service);
  const text = body ?? defaultGuideBody(kind, entity, service, repo);
  const nameTaken = guides.data?.guides.some((g) => g.name === name) ?? false;
  const desc = oneLine(description.trim());
  const src = oneLine(sources.trim());

  const local: Partial<Record<(typeof FIELDS)[number], string>> = {};
  if (kind === 'service' && service === '') local.service = `Every ${E} service already has a guide.`;
  if (!SKILL_NAME_RE.test(name) || name.length > SKILL_NAME_MAX) local.name = 'This name is not a valid guide name.';
  else if (nameTaken) local.name = `A guide named ${name} already exists.`;
  if (desc === '') local.description = 'Enter a description.';
  else if (desc.length > DESCRIPTION_MAX) local.description = `At most ${DESCRIPTION_MAX} characters.`;
  if (src.length > SOURCES_MAX) local.sources = `At most ${SOURCES_MAX} characters.`;
  if (text.trim() === '') local.body = 'The note cannot be empty.';
  else if (text.length > BODY_MAX) local.body = `At most ${BODY_MAX.toLocaleString('en')} characters.`;

  const errorFor = (field: (typeof FIELDS)[number]): string | undefined =>
    serverErrors.fields[field] ?? ((attempted || field === 'name' || field === 'service') ? local[field] : undefined);

  const change = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setServerErrors({ fields: {}, form: null });
  };

  const checks: CheckLine[] = [
    local.name === undefined
      ? { state: 'ok', text: 'Name matches the folder and is unique' }
      : { state: 'fail', text: local.name },
    kind === 'service'
      ? service !== ''
        ? { state: 'ok', text: <><span className="mono">{service}</span> is in the {E} registry</> }
        : { state: 'fail', text: `No ${E} service is waiting for a guide` }
      : { state: 'ok', text: <>{E} has a registry</> },
    desc === '' ? { state: 'warn', text: 'Description is empty' } : { state: 'ok', text: 'Description is set' },
  ];

  const preview = renderSkillFile(
    { name, description, kind, entity, ...(kind === 'service' ? { service: service || '<service>' } : {}), sources, status },
    text,
  );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setAttempted(true);
    if (Object.keys(local).length > 0) return;
    const payload: AddGuideBody = { kind, entity, description: desc, status, body: text };
    if (kind === 'service') payload.service = service;
    if (src !== '') payload.sources = src;
    setBusy(true);
    try {
      onSaved(await addGuide(payload), entity, kind);
    } catch (err) {
      setServerErrors(submitErrors(err, (field) => (field === 'name' ? `A guide named ${name} already exists.` : undefined)));
    } finally {
      setBusy(false);
    }
  };

  const leftover = leftoverErrors(serverErrors, FIELDS);

  const main = (
    <form onSubmit={submit} noValidate style={{ display: 'contents' }}>
      <Panel title="What it covers">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ width: 160, flexShrink: 0 }}>
              <Field label="Kind" error={errorFor('kind')}>
                <Select value={kind} onChange={(e) => change(setKind)(e.target.value === 'overview' ? 'overview' : 'service')}>
                  <option value="service">service</option>
                  <option value="overview">overview</option>
                </Select>
              </Field>
            </div>
            <div style={{ width: 140, flexShrink: 0 }}>
              <Field label="Entity" error={errorFor('entity')}>
                <Select value={entity} onChange={(e) => change(setEntity)(enabled.find((x) => x === e.target.value) ?? entity)}>
                  {enabled.map((x) => (
                    <option key={x} value={x}>
                      {x}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            {kind === 'service' && (
              <div style={{ flex: '1 1 200px', minWidth: 0 }}>
                <Field label="Service" hint="Only registry services without a guide are listed." error={errorFor('service')}>
                  <Select className="mono" value={service} onChange={(e) => change(setPickedService)(e.target.value)} disabled={open.length === 0}>
                    {open.length === 0 && <option value="">None left</option>}
                    {open.map((s) => (
                      <option key={s.key} value={s.key}>
                        {s.key}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            )}
          </div>
          <div>
            <span className="lbl">Name</span>
            <div
              className="mono"
              aria-live="polite"
              style={{ height: 40, display: 'flex', alignItems: 'center', padding: '0 12px', borderRadius: 'var(--radius)', background: 'var(--tone-muted-bg)', fontSize: 14 }}
            >
              {name}
            </div>
            <p className="hint">Set from entity and service. It is also the folder name.</p>
            {errorFor('name') !== undefined && <p className="field-error">{errorFor('name')}</p>}
          </div>
          <div>
            <Field label="Description" error={errorFor('description')}>
              <Textarea
                rows={2}
                value={description}
                maxLength={DESCRIPTION_MAX}
                onChange={(e) => change(setDescription)(oneLine(e.target.value))}
                placeholder="What the note covers and when to use it, on one line"
              />
            </Field>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
              <p className="hint">The only text the model sees before it opens the guide.</p>
              <p className="hint mono" aria-live="polite">
                {desc.length} / {DESCRIPTION_MAX}
              </p>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 240px', minWidth: 0 }}>
              <Field label="Sources" optional hint="The files the note was ported from, comma separated." error={errorFor('sources')}>
                <Input className="mono" value={sources} onChange={(e) => change(setSources)(e.target.value)} placeholder={`${entity}/${repo ?? '<repo>'}/AGENTS.md`} />
              </Field>
            </div>
            <div style={{ width: 160, flexShrink: 0 }}>
              <Field label="Status" error={errorFor('status')}>
                <Select value={status} onChange={(e) => change(setStatus)(GUIDE_STATUSES.find((s) => s === e.target.value) ?? 'stub')}>
                  {STATUS_ORDER.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          </div>
        </div>
      </Panel>
      <Panel title="Note" description="Markdown. Headings follow the other service guides.">
        <Field
          label={<span className="visually-hidden">Note body</span>}
          hint="Use placeholders such as <customer_id> or <account_form_id>. No real ids, URLs, hosts or env var names."
          error={errorFor('body')}
        >
          <Textarea className="mono" rows={14} style={{ fontSize: 13 }} value={text} onChange={(e) => change(setBody)(e.target.value)} spellCheck={false} />
        </Field>
      </Panel>
      {leftover !== null && <Notice variant="error" title="Not saved">{leftover}</Notice>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, paddingTop: 4 }}>
        <LinkButton to="/guides">Cancel</LinkButton>
        <Button type="submit" variant="primary" busy={busy} disabled={kind === 'service' && service === ''}>
          Save guide
        </Button>
      </div>
    </form>
  );

  const side = (
    <Panel title="Preview" description={`knowledge/${name}/SKILL.md`} as="aside" style={{ padding: 20 }}>
      <CheckList items={checks} />
      <CodePreview label="SKILL.md preview">{preview}</CodePreview>
      <p className="hint" style={{ margin: '12px 0 0' }}>
        Guides load once at boot. {kind === 'overview' ? 'The orchestrator' : `The ${E} investigator`} gets this one after the server restarts.
      </p>
    </Panel>
  );

  return <FormLayout main={main} side={side} sideWidth={380} />;
}

function Saved({ result, entity, kind }: { result: AddGuideResponse; entity: Entity; kind: GuideKind }) {
  const who = kind === 'overview' ? 'The orchestrator' : `The ${entityLabel(entity)} investigator`;
  return (
    <Panel title={<>Guide <span className="mono">{result.name}</span> saved</>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Notice variant="restart" title="Restart needed">
          Saved to <span className="mono">{result.file}</span>. {who} gets it after the server restarts.
        </Notice>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <LinkButton to={`/guides/${encodeURIComponent(result.name)}`} variant="primary">
            Open guide
          </LinkButton>
          <LinkButton to="/guides">All guides</LinkButton>
          <LinkButton to={`/services?entity=${entity}`} variant="ghost">
            Services
          </LinkButton>
        </div>
      </div>
    </Panel>
  );
}
