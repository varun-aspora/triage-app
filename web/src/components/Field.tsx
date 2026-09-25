// Form building blocks. Field wires a label, hint and error to one control by
// id so screen readers announce them together.

import {
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  cloneElement,
  isValidElement,
  useId,
} from 'react';

export function Label({ htmlFor, children, optional = false }: { htmlFor?: string; children: ReactNode; optional?: boolean }) {
  return (
    <label className="lbl" htmlFor={htmlFor}>
      {children}
      {optional && <span className="optional"> (optional)</span>}
    </label>
  );
}

export function Hint({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p className="hint" id={id}>
      {children}
    </p>
  );
}

export function FieldError({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p className="field-error" id={id} role="alert">
      {children}
    </p>
  );
}

type FieldProps = {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  optional?: boolean;
  /** One control: Input, Select, Textarea or any element that takes id and aria-*. */
  children: ReactNode;
  id?: string;
  className?: string;
};

export function Field({ label, hint, error, optional, children, id, className }: FieldProps) {
  const auto = useId();
  const controlId = id ?? `f${auto}`;
  const hintId = hint !== undefined ? `${controlId}-hint` : undefined;
  const errorId = error !== undefined && error !== null && error !== false ? `${controlId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  const control = isValidElement<Record<string, unknown>>(children)
    ? cloneElement(children, {
        id: controlId,
        'aria-describedby': describedBy,
        'aria-invalid': errorId !== undefined ? true : undefined,
      })
    : children;
  return (
    <div className={className}>
      <Label htmlFor={controlId} optional={optional}>
        {label}
      </Label>
      {control}
      {hint !== undefined && <Hint id={hintId}>{hint}</Hint>}
      {errorId !== undefined && <FieldError id={errorId}>{error}</FieldError>}
    </div>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={['field', className].filter(Boolean).join(' ')} {...rest} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={['field', className].filter(Boolean).join(' ')} {...rest}>
      {children}
    </select>
  );
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={['field', className].filter(Boolean).join(' ')} {...rest} />;
}

type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label: ReactNode };

export function Checkbox({ label, className, ...rest }: CheckboxProps) {
  return (
    <label className={['checkbox', className].filter(Boolean).join(' ')}>
      <input type="checkbox" {...rest} />
      <span>{label}</span>
    </label>
  );
}
