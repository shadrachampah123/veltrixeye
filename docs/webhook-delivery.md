# Webhook delivery security

Webhook notification signing secrets are currently stored as plaintext in the
server-side PostgreSQL tables (`notification_preferences.signing_secret` and
the durable webhook-delivery outbox). They are never returned by the API,
placed in notification DTOs, logs, audit metadata, provider errors, or request
payloads. The worker uses the secret only to calculate the HMAC signature for
the exact JSON body sent to the configured HTTPS endpoint.

This is an explicit current-storage limitation: anyone who obtains a database
backup, read access, or equivalent database compromise can read a webhook
signing secret and impersonate VeltrixEye when signing requests. Database
access must therefore be tightly controlled, encrypted in transit and at rest,
and backups must receive the same protection. This design does not claim that
plaintext database storage is equivalent to an external secret manager; adding
one is a separate operational change and is not required by the current
architecture.

Delivery also validates HTTPS, rejects URL credentials, resolves every DNS
address and rejects private, loopback, link-local, multicast, documentation,
benchmark, carrier-grade NAT, reserved and special-purpose IPv4/IPv6 ranges,
including IPv4-mapped IPv6 addresses. The actual request is pinned to the
validated address, does not follow redirects, and shares one bounded deadline
between DNS resolution and the HTTPS request.
