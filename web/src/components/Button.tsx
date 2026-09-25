import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router';
import { Icon, type IconName } from './Icon.tsx';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';
export type ButtonSize = 'md' | 'sm';

function classes(variant: ButtonVariant, size: ButtonSize, extra?: string): string {
  return ['btn', `btn-${variant}`, size === 'sm' ? 'btn-sm' : '', extra ?? ''].filter(Boolean).join(' ');
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  /** Shows a spinner and disables the button. */
  busy?: boolean;
  children?: ReactNode;
};

/** Primary uses the environment accent; secondary and ghost are neutral. */
export function Button({ variant = 'secondary', size = 'md', icon, busy = false, className, children, disabled, type, ...rest }: ButtonProps) {
  return (
    <button
      type={type ?? 'button'}
      className={classes(variant, size, className)}
      disabled={disabled === true || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? <Icon name="spinner" size={size === 'sm' ? 14 : 16} className="spin" /> : icon && <Icon name={icon} size={size === 'sm' ? 14 : 16} />}
      {children}
    </button>
  );
}

type LinkButtonProps = LinkProps & { variant?: ButtonVariant; size?: ButtonSize; icon?: IconName };

/** A router link that looks like a button. */
export function LinkButton({ variant = 'secondary', size = 'md', icon, className, children, ...rest }: LinkButtonProps) {
  return (
    <Link className={classes(variant, size, className)} {...rest}>
      {icon && <Icon name={icon} size={size === 'sm' ? 14 : 16} />}
      {children}
    </Link>
  );
}
