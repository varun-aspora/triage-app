import { Link, useSearchParams } from 'react-router';
import { listServices } from '../../api/endpoints.ts';
import type { Entity, EnvKeyRef, ServiceRow } from '../../api/types.ts';
import { Button, LinkButton } from '../../components/Button.tsx';
import { EmptyState } from '../../components/EmptyState.tsx';
import { ErrorNotice, Loading } from '../../components/LoadState.tsx';
import { Notice } from '../../components/Notice.tsx';
import { PageHeader } from '../../components/PageHeader.tsx';
import { Panel } from '../../components/Panel.tsx';
import { Chip, StatusTag } from '../../components/StatusTag.tsx';
import { Tabs } from '../../components/Tabs.tsx';
import { useApi } from '../../lib/useApi.ts';
import { SERVICE_KEY_RE, entityLabel, guideStatusTone, matchesInOtherEntities, serviceMatches } from './catalog.ts';
import { Dash, SearchInput } from './parts.tsx';

const DESCRIPTION = 'The service registry per entity. Investigators can only query the databases, APIs and log services listed here.';

export default function ServicesPage() {
  const { data, error, loading, reload } = useApi((signal) => listServices({ signal }), []);
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';

  const header = (
    <PageHeader
      title="Services"
      description={DESCRIPTION}
      actions={
        <LinkButton to="/services/new" variant="primary" icon="plus">
          Add service
        </LinkButton>
      }
    />
  );

  if (loading) return <>{header}<Loading /></>;
  if (data === undefined) return <>{header}<ErrorNotice error={error} onRetry={reload} /></>;

  const groups = data.entities;
  if (groups.length === 0) {
    return (
      <>
        {header}
        <Panel>
          <EmptyState icon="services" title="No entities are enabled">
            Enable an entity in the server config to see its services here.
          </EmptyState>
        </Panel>
      </>
    );
  }

  const requested = params.get('entity');
  const active = groups.find((g) => g.entity === requested) ?? groups[0]!;

  const update = (next: { entity?: Entity; q?: string }) => {
    const p = new URLSearchParams(params);
    if (next.entity !== undefined) p.set('entity', next.entity);
    if (next.q !== undefined) {
      if (next.q === '') p.delete('q');
      else p.set('q', next.q);
    }
    setParams(p, { replace: true });
  };

  const rows = active.services.filter((row) => serviceMatches(row, q));

  return (
    <>
      {header}
      {data.restart_required && <Notice variant="restart">Saved changes reach the agents after the server restarts.</Notice>}
      <Tabs
        label="Entity"
        tabs={groups.map((g) => ({ id: g.entity, label: entityLabel(g.entity), count: g.services.length }))}
        active={active.entity}
        onChange={(entity) => update({ entity })}
      />
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
        <SearchInput id="svcq" value={q} onChange={(value) => update({ q: value })} placeholder="Service, repo or log service" />
      </div>
      <Panel padded={false}>
        {rows.length > 0 ? (
          <ServiceTable entity={active.entity} rows={rows} />
        ) : active.services.length === 0 && q.trim() === '' ? (
          <EmptyState
            icon="services"
            title={`${entityLabel(active.entity)} has no services yet`}
            actions={
              <LinkButton to={`/services/new?entity=${active.entity}`} variant="primary" icon="plus">
                Add service
              </LinkButton>
            }
          >
            Its investigator cannot query anything until a service is registered.
          </EmptyState>
        ) : (
          <NoMatch
            entity={active.entity}
            q={q.trim()}
            others={matchesInOtherEntities(groups, active.entity, q)}
            onView={(entity) => update({ entity })}
            onClear={() => update({ q: '' })}
          />
        )}
      </Panel>
    </>
  );
}

function ServiceTable({ entity, rows }: { entity: Entity; rows: readonly ServiceRow[] }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Service</th>
            <th scope="col">Repo</th>
            <th scope="col">Log service</th>
            <th scope="col">Database key</th>
            <th scope="col">API key</th>
            <th scope="col">Guide</th>
            <th scope="col">Note</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <td>
                <div className="mono" style={{ fontWeight: 500 }}>
                  {row.key}
                </div>
                {row.pending_restart && (
                  <div style={{ marginTop: 4 }}>
                    <StatusTag tone="amber" icon="clock" title="Added by this server; agents see it after a restart">
                      restart needed
                    </StatusTag>
                  </div>
                )}
              </td>
              <td className="mono" style={{ fontSize: 13 }}>
                {row.repo ?? <Dash />}
              </td>
              <td className="mono" style={{ fontSize: 13 }}>
                {row.quickwit_service ?? <Dash />}
              </td>
              <td>
                <EnvKey value={row.db_env} />
              </td>
              <td>
                <EnvKey value={row.api_env} />
              </td>
              <td>
                {row.guide !== null ? (
                  <Link to={`/guides/${encodeURIComponent(row.guide.name)}`} className="link" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <span className="mono" style={{ fontSize: 12 }}>
                      {row.guide.name}
                    </span>
                    {row.guide.status !== null && <StatusTag look={guideStatusTone(row.guide.status)}>{row.guide.status}</StatusTag>}
                  </Link>
                ) : (
                  <Link
                    to={`/guides/new?kind=service&entity=${entity}&service=${encodeURIComponent(row.key)}`}
                    className="link"
                    style={{ fontSize: 13 }}
                  >
                    Write guide
                  </Link>
                )}
              </td>
              <td style={{ fontSize: 13, color: 'var(--text-2)' }}>{row.note ?? <Dash />}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EnvKey({ value }: { value: EnvKeyRef | null }) {
  if (value === null) return <Dash />;
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
      <span className="mono" style={{ fontSize: 12, color: 'var(--text-2)' }}>
        {value.name}
      </span>
      {value.state === 'blank' && <Chip tone="muted">blank</Chip>}
      {value.state === 'missing' && <Chip tone="muted">missing in .env</Chip>}
    </span>
  );
}

function NoMatch({
  entity,
  q,
  others,
  onView,
  onClear,
}: {
  entity: Entity;
  q: string;
  others: ReturnType<typeof matchesInOtherEntities>;
  onView: (entity: Entity) => void;
  onClear: () => void;
}) {
  // Only a valid key can prefill the add form; otherwise the operator types one there.
  const addTo = `/services/new?entity=${entity}${SERVICE_KEY_RE.test(q) ? `&key=${encodeURIComponent(q)}` : ''}`;
  return (
    <EmptyState
      title={`No ${entityLabel(entity)} service matches “${q}”`}
      actions={
        <>
          <Button onClick={onClear}>Clear search</Button>
          <LinkButton to={addTo} variant="primary" icon="plus">
            Add “{q}” to {entityLabel(entity)}
          </LinkButton>
        </>
      }
    >
      <p style={{ margin: 0 }}>Before adding it, check it is not already registered under another entity.</p>
      {others.length > 0 && (
        <div
          style={{
            margin: '20px auto 0',
            width: 520,
            maxWidth: '100%',
            textAlign: 'left',
            border: '1px solid var(--line)',
            borderRadius: 'var(--radius-lg)',
            overflow: 'hidden',
            color: 'var(--text)',
          }}
        >
          <div style={{ padding: '10px 14px', background: 'var(--surface-sunk)', fontSize: 12, fontWeight: 500, color: 'var(--muted)' }}>
            Found in other entities
          </div>
          {others.map(({ entity: other, row }) => (
            <div
              key={`${other}:${row.key}`}
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderTop: '1px solid var(--line-soft)' }}
            >
              <Chip>{entityLabel(other)}</Chip>
              <div style={{ flexGrow: 1, minWidth: 0 }}>
                <div className="mono" style={{ fontSize: 14, fontWeight: 500 }}>
                  {row.key}
                </div>
                <div className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {[row.repo !== null ? `repo ${row.repo}` : null, row.quickwit_service !== null ? `logs ${row.quickwit_service}` : null]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </div>
              <button
                type="button"
                onClick={() => onView(other)}
                style={{ border: 0, background: 'none', font: 'inherit', fontSize: 14, fontWeight: 500, color: 'var(--accent)', cursor: 'pointer' }}
              >
                View
              </button>
            </div>
          ))}
        </div>
      )}
    </EmptyState>
  );
}
