import { Link, useSearchParams } from 'react-router';
import { listGuides } from '../../api/endpoints.ts';
import { LinkButton } from '../../components/Button.tsx';
import { EmptyState } from '../../components/EmptyState.tsx';
import { Select } from '../../components/Field.tsx';
import { ErrorNotice, Loading } from '../../components/LoadState.tsx';
import { Notice } from '../../components/Notice.tsx';
import { PageHeader } from '../../components/PageHeader.tsx';
import { Panel } from '../../components/Panel.tsx';
import { StatusTag } from '../../components/StatusTag.tsx';
import { ENTITIES, GUIDE_STATUSES } from '../../lib/constants.ts';
import { useApi } from '../../lib/useApi.ts';
import { type GuideFilter, guideMatches, guideStatusTone } from './catalog.ts';
import { SearchInput } from './parts.tsx';

const DESCRIPTION = 'The knowledge notes the agents load: one per entity overview, one per registry service, and a few shared ones.';
const KINDS = ['service', 'overview', 'patterns', 'repo-map', 'codegraph-limits', 'frontend-routing'];
const ENTITY_FILTERS = [...ENTITIES, 'shared'];

export default function GuidesPage() {
  const { data, error, loading, reload } = useApi((signal) => listGuides({ signal }), []);
  const [params, setParams] = useSearchParams();
  const filter: GuideFilter = {
    q: params.get('q') ?? '',
    entity: params.get('entity') ?? '',
    kind: params.get('kind') ?? '',
    status: params.get('status') ?? '',
  };

  const set = (name: keyof GuideFilter, value: string) => {
    const p = new URLSearchParams(params);
    if (value === '') p.delete(name);
    else p.set(name, value);
    setParams(p, { replace: true });
  };

  const header = (
    <PageHeader
      title="Guides"
      description={DESCRIPTION}
      actions={
        <LinkButton to="/guides/new" variant="primary" icon="plus">
          New guide
        </LinkButton>
      }
    />
  );

  if (loading) return <>{header}<Loading /></>;
  if (data === undefined) return <>{header}<ErrorNotice error={error} onRetry={reload} /></>;

  const kinds = [...KINDS, ...new Set(data.guides.map((g) => g.kind).filter((k) => !KINDS.includes(k)))];
  const rows = data.guides.filter((g) => guideMatches(g, filter));
  const filtered = filter.q !== '' || filter.entity !== '' || filter.kind !== '' || filter.status !== '';

  return (
    <>
      {header}
      {data.restart_required && <Notice variant="restart">Saved changes reach the agents after the server restarts.</Notice>}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <Count label="Guides" value={data.counts.total} />
        <Count label="Ported" value={data.counts.ported} dot="var(--tone-info-fg)" />
        <Count label="Written" value={data.counts.written} dot="var(--text-2)" />
        <Count label="Stub, need content" value={data.counts.stub} dot="var(--tone-amber-fg)" />
      </div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <SearchInput id="gq" value={filter.q} onChange={(v) => set('q', v)} placeholder="Name or description" width={300} />
        <div style={{ width: 140, flexShrink: 0 }}>
          <label className="lbl" htmlFor="gent">
            Entity
          </label>
          <Select id="gent" value={filter.entity} onChange={(e) => set('entity', e.target.value)}>
            <option value="">All</option>
            {ENTITY_FILTERS.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </Select>
        </div>
        <div style={{ width: 170, flexShrink: 0 }}>
          <label className="lbl" htmlFor="gkind">
            Kind
          </label>
          <Select id="gkind" value={filter.kind} onChange={(e) => set('kind', e.target.value)}>
            <option value="">All</option>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </Select>
        </div>
        <div role="group" aria-label="Status" style={{ display: 'flex', gap: 6, paddingBottom: 4 }}>
          {['', ...GUIDE_STATUSES].map((s) => (
            <Pill key={s || 'all'} pressed={filter.status === s} onClick={() => set('status', s)}>
              {s || 'All'}
            </Pill>
          ))}
        </div>
      </div>
      <Panel padded={false}>
        {rows.length === 0 ? (
          <EmptyState title={filtered ? 'No guide matches these filters' : 'No guides yet'}>
            {filtered ? 'Change the search or filters to see more.' : 'Write one for an entity overview or a registry service.'}
          </EmptyState>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Entity</th>
                  <th scope="col">Status</th>
                  <th scope="col">Description</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((g) => (
                  <tr key={g.name}>
                    <td>
                      <Link to={`/guides/${encodeURIComponent(g.name)}`} className="link mono" style={{ fontSize: 13, fontWeight: 500 }}>
                        {g.name}
                      </Link>
                      {g.pending_restart && (
                        <div style={{ marginTop: 4 }}>
                          <StatusTag tone="amber" icon="clock" title="Written by this server; agents see it after a restart">
                            restart needed
                          </StatusTag>
                        </div>
                      )}
                    </td>
                    <td style={{ fontSize: 13 }}>{g.kind}</td>
                    <td className="mono" style={{ fontSize: 13 }}>
                      {g.entity}
                    </td>
                    <td>
                      <StatusTag look={guideStatusTone(g.status)}>{g.status ?? 'no status'}</StatusTag>
                    </td>
                    <td style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.45 }}>
                      {g.problem !== undefined ? <span style={{ color: 'var(--tone-rust-fg)' }}>{g.problem}</span> : g.description}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div style={{ padding: 12, fontSize: 13, color: 'var(--muted)', borderTop: rows.length === 0 ? '1px solid var(--line-soft)' : undefined }}>
          {rows.length} of {data.guides.length} shown
        </div>
      </Panel>
    </>
  );
}

function Count({ label, value, dot }: { label: string; value: number; dot?: string }) {
  return (
    <div style={{ flex: '1 1 160px', padding: '14px 16px', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--radius-lg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--muted)' }}>
        {dot !== undefined && <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 4, background: dot }} />}
        {label}
      </div>
      <div style={{ fontSize: 24, fontWeight: 600, margin: '4px 0 0' }}>{value}</div>
    </div>
  );
}

function Pill({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      style={{
        height: 32,
        padding: '0 12px',
        borderRadius: 16,
        border: `1px solid ${pressed ? 'var(--accent)' : 'var(--field-line)'}`,
        background: pressed ? 'var(--accent-soft)' : 'var(--surface)',
        color: pressed ? 'var(--accent)' : 'var(--text-2)',
        font: 'inherit',
        fontSize: 13,
        fontWeight: 500,
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}
