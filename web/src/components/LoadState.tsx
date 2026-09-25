// Loading and error states for data fetched with useApi.

import { ApiError } from '../api/client.ts';
import { Button } from './Button.tsx';
import { Icon } from './Icon.tsx';
import { Notice } from './Notice.tsx';

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 24, color: 'var(--muted)', fontSize: 14 }}>
      <Icon name="spinner" className="spin" />
      {label}
    </div>
  );
}

/** A short, value-free description of an API error: the server's error text plus the fields it names. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    const fields = err.body.fields !== undefined && err.body.fields.length > 0 ? ` (${err.body.fields.join(', ')})` : '';
    const reason = err.body.reason !== undefined ? `: ${err.body.reason}` : '';
    return `${err.body.error}${fields}${reason}`;
  }
  return err instanceof Error ? err.message : 'Something went wrong.';
}

export function ErrorNotice({ error, onRetry, title = 'Could not load this' }: { error: unknown; onRetry?: () => void; title?: string }) {
  return (
    <Notice
      variant="error"
      title={title}
      actions={onRetry !== undefined ? <Button size="sm" onClick={onRetry} icon="refresh">Retry</Button> : undefined}
    >
      {describeError(error)}
    </Notice>
  );
}
