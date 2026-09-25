// Page frame: environment banner, sidebar navigation and the routed page.

import type { CSSProperties } from 'react';
import { NavLink, Outlet } from 'react-router';
import { Icon, type IconName } from '../components/Icon.tsx';
import { EnvBanner } from './EnvBanner.tsx';
import { useSession } from './session.ts';

const MAIN_NAV: readonly { to: string; label: string; icon: IconName }[] = [
  { to: '/runs', label: 'Runs', icon: 'runs' },
  { to: '/services', label: 'Services', icon: 'services' },
  { to: '/guides', label: 'Guides', icon: 'guides' },
];

const OPS_NAV: readonly { to: string; label: string; icon: IconName }[] = [
  { to: '/repos', label: 'Repos', icon: 'repos' },
  { to: '/doctor', label: 'Doctor', icon: 'doctor' },
];

const navItem = (active: boolean): CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  height: 40,
  padding: '0 12px',
  borderRadius: 6,
  textDecoration: 'none',
  fontSize: 14,
  color: active ? 'var(--accent)' : 'var(--text-2)',
  background: active ? 'var(--surface)' : 'transparent',
  fontWeight: active ? 600 : 400,
  boxShadow: active ? '0 0 0 1px var(--line)' : 'none',
});

function NavItem({ to, label, icon }: { to: string; label: string; icon: IconName }) {
  return (
    <NavLink to={to} style={({ isActive }) => navItem(isActive)}>
      <Icon name={icon} />
      <span>{label}</span>
    </NavLink>
  );
}

export function Shell() {
  const { session, signOut } = useSession();
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <EnvBanner />
      <div style={{ flexGrow: 1, minHeight: 0, display: 'flex' }}>
        <nav
          aria-label="Main"
          style={{
            width: 232,
            flexShrink: 0,
            padding: '24px 16px',
            background: 'var(--sidebar)',
            borderRight: '1px solid var(--line)',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            overflowY: 'auto',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '0 12px 20px' }}>
            <span style={{ fontSize: 18, fontWeight: 600, letterSpacing: '-0.01em' }}>triage</span>
            <span className="mono muted" style={{ fontSize: 12 }}>
              console
            </span>
          </div>
          {MAIN_NAV.map((item) => (
            <NavItem key={item.to} {...item} />
          ))}
          <div style={{ height: 1, background: 'var(--line-strong)', margin: 12 }} />
          <div
            style={{
              fontSize: 11,
              fontWeight: 500,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: 'var(--muted)',
              padding: '0 12px 6px',
            }}
          >
            Ops
          </div>
          {OPS_NAV.map((item) => (
            <NavItem key={item.to} {...item} />
          ))}
          <div style={{ flexGrow: 1 }} />
          <div
            style={{
              padding: 12,
              borderRadius: 6,
              background: 'var(--surface)',
              boxShadow: '0 0 0 1px var(--line)',
              fontSize: 12,
              lineHeight: 1.5,
              color: 'var(--text-2)',
            }}
          >
            <div style={{ fontWeight: 600 }}>{session.mock_mode ? 'Mock mode' : 'Live mode'}</div>
            <div>{session.mock_mode ? 'Tools answer from fixtures' : 'Tools read real systems, read-only'}</div>
          </div>
          <button
            type="button"
            onClick={signOut}
            className="btn btn-ghost btn-sm"
            style={{ justifyContent: 'flex-start', marginTop: 8, paddingLeft: 12 }}
          >
            <Icon name="signout" size={14} />
            Sign out
          </button>
        </nav>
        <main
          style={{
            flexGrow: 1,
            minWidth: 0,
            overflowY: 'auto',
            padding: '32px 40px',
            display: 'flex',
            flexDirection: 'column',
            gap: 24,
          }}
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}
