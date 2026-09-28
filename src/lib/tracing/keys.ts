// The keys each vendor's Flue instrumentation writes the instance id under
// (D91). Kept apart from the adapters so keys.test.ts can check them without
// loading the vendor SDKs.

/** Braintrust metadata key. */
export const BRAINTRUST_RUN_ID_KEY = 'flue.instance_id';

/** @flue/opentelemetry span attribute. */
export const OTLP_RUN_ID_KEY = 'flue.instance.id';
