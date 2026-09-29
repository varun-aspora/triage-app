import { Fragment, type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { copyText } from '../lib/clipboard.ts';
import { usePageTitle } from '../lib/usePageTitle.ts';
import { Icon } from './Icon.tsx';

/** copy puts a copy button after the crumb; copyLabel names it for screen readers. */
export type Crumb = { label: ReactNode; to?: string; copy?: string; copyLabel?: string };

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
                {c.copy !== undefined && <CopyCrumb text={c.copy} label={c.copyLabel ?? 'Copy'} />}
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

function CopyCrumb({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const t = setTimeout(() => setState('idle'), 2000);
    return () => clearTimeout(t);
  }, [state]);
  const title = state === 'ok' ? 'Copied' : state === 'fail' ? 'Copy failed' : label;
  return (
    <button
      type="button"
      className="crumb-copy"
      aria-label={title}
      title={title}
      onClick={() => void copyText(text).then((ok) => setState(ok ? 'ok' : 'fail'))}
    >
      <Icon name={state === 'ok' ? 'check' : state === 'fail' ? 'x' : 'copy'} size={14} />
    </button>
  );
}
