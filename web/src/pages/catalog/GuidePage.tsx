import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { getGuide } from '../../api/endpoints.ts';
import type { GuideDetail } from '../../api/types.ts';
import { LinkButton } from '../../components/Button.tsx';
import { EmptyState } from '../../components/EmptyState.tsx';
import { ErrorNotice, Loading } from '../../components/LoadState.tsx';
import { Notice, RestartNotice } from '../../components/Notice.tsx';
import { PageHeader } from '../../components/PageHeader.tsx';
import { Panel } from '../../components/Panel.tsx';
import { Chip, StatusTag } from '../../components/StatusTag.tsx';
import { useApi } from '../../lib/useApi.ts';
import { guideStatusTone, isNotFound } from './catalog.ts';
import { Dash } from './parts.tsx';

const CRUMBS = [{ label: 'Guides', to: '/guides' }];

export default function GuidePage() {
  const name = useParams().name ?? '';
  const { data, error, loading, reload } = useApi((signal) => getGuide(name, { signal }), [name]);

  if (loading) return <><PageHeader title={name} breadcrumb={CRUMBS} /><Loading /></>;
  if (data === undefined) {
    return (
      <>
        <PageHeader title={name} breadcrumb={CRUMBS} />
        {isNotFound(error) ? (
          <Panel>
            <EmptyState
              icon="guides"
              title="Guide not found"
              actions={<LinkButton to="/guides">All guides</LinkButton>}
            >
              There is no guide named <span className="mono">{name}</span> in the knowledge folder.
            </EmptyState>
          </Panel>
        ) : (
          <ErrorNotice error={error} onRetry={reload} />
        )}
      </>
    );
  }
  return <Guide guide={data} />;
}

function Guide({ guide }: { guide: GuideDetail }) {
  return (
    <>
      <PageHeader title={<span className="mono">{guide.name}</span>} documentTitle={guide.name} breadcrumb={CRUMBS}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Chip>{guide.kind}</Chip>
          <Chip mono>{guide.entity}</Chip>
          <StatusTag look={guideStatusTone(guide.status)}>{guide.status ?? 'no status'}</StatusTag>
        </div>
      </PageHeader>
      {guide.pending_restart && <RestartNotice>Saved to disk. Agents get this guide after the server restarts.</RestartNotice>}
      {guide.problem !== undefined && (
        <Notice variant="error" title="This file does not parse">
          {guide.problem}
        </Notice>
      )}
      <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <Panel title="Note" description={`knowledge/${guide.name}/SKILL.md`} style={{ flex: '1 1 520px' }}>
          {guide.body.trim() === '' ? (
            <p className="muted" style={{ margin: 0 }}>
              The note is empty.
            </p>
          ) : (
            <pre
              style={{
                fontSize: 13,
                lineHeight: 1.6,
                padding: '14px 16px',
                background: 'var(--surface-sunk)',
                border: '1px solid var(--line-soft)',
                borderRadius: 'var(--radius)',
                overflowX: 'auto',
              }}
            >
              {guide.body}
            </pre>
          )}
        </Panel>
        <div style={{ flex: '0 1 360px', minWidth: 280, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Panel title="Front-matter" as="aside" style={{ padding: 20 }}>
            <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '10px 16px', fontSize: 13 }}>
              <Row label="name"><span className="mono">{guide.name}</span></Row>
              <Row label="description">{guide.description !== '' ? guide.description : <Dash />}</Row>
              <Row label="kind">{guide.kind}</Row>
              <Row label="entity"><span className="mono">{guide.entity}</span></Row>
              {guide.service !== null && (
                <Row label="service">
                  <Link className="link mono" to={`/services?entity=${encodeURIComponent(guide.entity)}&q=${encodeURIComponent(guide.service)}`}>
                    {guide.service}
                  </Link>
                </Row>
              )}
              <Row label="sources">{guide.sources !== null ? <span className="mono" style={{ wordBreak: 'break-word' }}>{guide.sources}</span> : <Dash />}</Row>
              <Row label="status">{guide.status ?? <Dash />}</Row>
            </dl>
          </Panel>
          <Panel title="Supporting files" as="aside" style={{ padding: 20 }}>
            {guide.files.length === 0 ? (
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                None. The guide is just its SKILL.md.
              </p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                {guide.files.map((f) => (
                  <li key={f} className="mono">
                    {f}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="muted mono" style={{ fontSize: 12, paddingTop: 1 }}>
        {label}
      </dt>
      <dd style={{ margin: 0, minWidth: 0 }}>{children}</dd>
    </>
  );
}
