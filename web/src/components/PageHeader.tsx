import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router';
import { usePageTitle } from '../lib/usePageTitle.ts';

export type Crumb = { label: ReactNode; to?: string };

type Props = {
  title: ReactNode;
  /** Browser tab title when title is not plain text. */
  documentTitle?: string;
  description?: ReactNode;
  breadcrumb?: readonly Crumb[];
  actions?: ReactNode;
  /** Chips or meta lines under the title. */
  children?: ReactNode;
};

export function PageHeader({ title, documentTitle, description, breadcrumb, actions, children }: Props) {
  usePageTitle(documentTitle ?? (typeof title === 'string' ? title : 'triage console'));
  return (
    <header style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 24, flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
        {breadcrumb !== undefined && breadcrumb.length > 0 && (
          <nav aria-label="Breadcrumb" style={{ fontSize: 13 }}>
            {breadcrumb.map((c, i) => (
              <Fragment key={i}>
                {i > 0 && <span className="muted"> / </span>}
                {c.to !== undefined ? (
                  <Link to={c.to} className="link">
                    {c.label}
                  </Link>
                ) : (
                  <span className="mono">{c.label}</span>
                )}
              </Fragment>
            ))}
          </nav>
        )}
        <h1 style={{ fontSize: breadcrumb !== undefined ? 24 : 28, lineHeight: 1.2, fontWeight: 600, letterSpacing: '-0.01em', maxWidth: 820 }}>
          {title}
        </h1>
        {description !== undefined && (
          <p style={{ margin: 0, fontSize: 14, color: 'var(--muted)', maxWidth: 640, lineHeight: 1.5 }}>{description}</p>
        )}
        {children}
      </div>
      {actions !== undefined && <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>{actions}</div>}
    </header>
  );
}
