export {
  PAYSTACK_API_BASE_URL,
  PAYSTACK_LIVE,
  PAYSTACK_TEST_KEY_PREFIX,
  PaystackClient,
  type PaystackClientConfig,
  type PaystackCustomerRecord,
  type PaystackFetchFn,
  type PaystackInitializedTransaction,
} from './client.js';

export {
  PAYSTACK_ERROR_MESSAGE_MAX,
  PaystackAdapterError,
  isPaystackAdapterError,
  redactPaystackMessage,
  type PaystackFailureReason,
} from './errors.js';

export {
  PAYSTACK_IMPLEMENTED_OPERATIONS,
  PAYSTACK_UNIMPLEMENTED_REASONS,
  PaystackBillingProvider,
  PaystackNotImplementedError,
  createPaystackProvider,
  deterministicLocalId,
  isPaystackNotImplementedError,
  type PaystackCustomerDirectory,
  type PaystackOperation,
  type PaystackPlanDirectory,
  type PaystackProviderConfig,
} from './provider.js';

/**
 * The verified webhook event contract (Billing Step 5.1). Exported so the
 * receiver that lands next — and only that receiver — can dispatch on the same
 * pinned vocabulary instead of restating provider event names anywhere else.
 */
export {
  PAYSTACK_CANONICAL_EVENT_TYPES,
  PAYSTACK_LIFECYCLE_STATE_FOR_STATUS,
  PAYSTACK_SUPPORTED_EVENTS,
  PAYSTACK_UNSUPPORTED_EVENT_REASONS,
  PAYSTACK_WITHHELD_FAILURE_DETAIL,
  isPaystackSupportedEvent,
  normalizePaystackEventPayload,
  paystackLifecycleState,
  sanitizePaystackFailureDetail,
  type PaystackEventFacts,
  type PaystackSupportedEvent,
} from './events.js';
