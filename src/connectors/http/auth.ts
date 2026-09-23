// Request headers for the admin HTTP connector (HLD §2 http_call row, §3
// http.ts; D8, D31).
//
// This is the only place the connector's headers are made. They come from
// three sources and nothing else: the registry auth for the service, the
// validated customer id, and a fixed accept header. There is no input for
// headers from the caller or the model.
//
// Token values are read from the registry capability (a non-enumerable
// property) and never appear in a message or a returned refusal.
import { Buffer } from 'node:buffer';
import type { AuthCapability } from '../../config/registry.ts';
import { buildHeaders, type AuthHeader } from '../../gate/http.ts';

export const CUSTOMER_ID_PATTERN = /^[A-Za-z0-9-]+$/;

export const ACCEPT_JSON = 'application/json';

export type AuthRefusal = {
  readonly ok: false;
  readonly code: 'not_configured' | 'refused';
  /** Names env vars and header names only. */
  readonly message: string;
};

export type ResolvedAuth = { readonly ok: true; readonly auth?: AuthHeader };

/** True when the id can go into a header as is: letters, digits and '-'. */
export function isValidCustomerId(id: unknown): id is string {
  return typeof id === 'string' && CUSTOMER_ID_PATTERN.test(id);
}

/**
 * Turns the registry auth capability into the header the request carries.
 * No capability means the service takes no auth. A blank token_env is
 * not_configured and names the env var. Basic sends base64 of the env value;
 * Bearer sends the value as is.
 */
export function resolveAuth(cap: AuthCapability | undefined): ResolvedAuth | AuthRefusal {
  if (cap === undefined) return { ok: true };
  if (cap.status !== 'ok' || cap.value.trim() === '') {
    return { ok: false, code: 'not_configured', message: `${cap.envName} is blank, so the service has no credentials` };
  }
  const token = cap.scheme === 'Basic' ? Buffer.from(cap.value, 'utf8').toString('base64') : cap.value;
  return { ok: true, auth: { header: cap.header, scheme: cap.scheme, token } };
}

export type ConnectorHeaderInput = {
  readonly auth?: AuthHeader;
  /** The registry customer_header for the service, such as x-customer-id. */
  readonly customerHeader?: string;
  readonly customerId?: string;
  /** Adds content-type: application/json. */
  readonly jsonBody?: boolean;
};

export type ConnectorHeaders = { readonly ok: true; readonly headers: Readonly<Record<string, string>> };

/**
 * Builds the full header set. The customer header is sent only when the
 * registry names one for the service; a customer id that fails
 * ^[A-Za-z0-9-]+$ is refused whether or not it would be sent.
 */
export function connectorHeaders(input: ConnectorHeaderInput): ConnectorHeaders | AuthRefusal {
  if (input.customerId !== undefined && !isValidCustomerId(input.customerId)) {
    return {
      ok: false,
      code: 'refused',
      message: 'the customer id may use only letters, digits and -; call without it',
    };
  }
  const built = buildHeaders({
    ...(input.auth !== undefined ? { auth: input.auth } : {}),
    ...(input.customerHeader !== undefined ? { customerHeader: input.customerHeader } : {}),
    idChain: { ids: input.customerId !== undefined ? { customer_id: input.customerId } : {} },
  });
  if (!built.ok) {
    // The gate message names header names and fixed reasons only.
    return { ok: false, code: 'refused', message: built.message };
  }
  const headers: Record<string, string> = { ...built.headers, accept: ACCEPT_JSON };
  if (input.jsonBody === true) headers['content-type'] = 'application/json';
  return { ok: true, headers: Object.freeze(headers) };
}
