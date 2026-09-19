# Webhook delivery security (M9.2 hardened)

Webhook notification signing secrets and push subscription keys are now encrypted at rest via application-level AES-256-GCM using `WEBHOOK_SECRET_ENCRYPTION_KEY`.

- Storage: `notification_preferences.signing_secret_encrypted` + `signing_secret_key_version`, `notification_webhook_deliveries.signing_secret_encrypted`, `notification_push_deliveries.signing_secret_encrypted` (push stores JSON `{p256dh, auth}` encrypted). Plaintext columns `signing_secret` are kept nullable for safe migration path but new writes store encrypted and null out plaintext. Reads prefer encrypted, fallback plaintext for existing rows until migrated.
- Encryption: 32-byte key (base64), random IV 12B per encryption, authTag 16B, versioned format `v<version>:<base64(iv+tag+ciphertext)>`, key-version column allows rotation. `SecretManager` abstraction (`EnvKeySecretManager` production, `NoopSecretManager` test/dev only). Production fails closed if `WEBHOOK_SECRET_ENCRYPTION_KEY` missing/invalid — `createSecretManager` throws at boot, no silent fallback. Render's encrypted env vars alone do NOT constitute DB secret protection (explicitly documented).
- API hygiene: secrets never returned by API, never in notification DTOs, logs, audit metadata, provider errors, or request payloads. Webhook secret input write-only (•••• placeholder). Push keys never returned. VAPID private key server-only, never in `describe()`, logs, errors, audit.
- Worker: decrypts signing secret inside delivery transaction only for HMAC calculation (`x-veltrixeye-signature: sha256=HMAC(body)`), or for push subscription. Decryption errors fallback to plaintext for migration, but new code path is encrypted.
- Existing production webhook secrets migration: on upgrade 0027→0028, encrypted columns added nullable, old plaintext preserved. Application on next `upsert` encrypts and nulls plaintext. No secrets exposed in logs or test output.

Delivery also validates HTTPS, rejects URL credentials, resolves every DNS address and rejects private, loopback, link-local, multicast, documentation, benchmark, carrier-grade NAT, reserved and special-purpose IPv4/IPv6 ranges, including IPv4-mapped IPv6 addresses. The actual request is pinned to the validated address, does not follow redirects, and shares one bounded deadline between DNS resolution and the HTTPS request.

Push delivery (M9.2): endpoint must be HTTPS, subscription JSON strictly validated (`p256dh` base64url 20-512, `auth` base64url 10-512), VAPID JWT signed with private key, outcome 200/201 delivered, 404/410 permanent (subscription gone), 429 retryable, 5xx retryable, timeout retryable. Expired subscriptions handled safely (permanent failure, no retry loop).

Fairness (M9.2): lifetime `email_claims, webhook_claims, push_claims` under advisory lock 611_231_008 + `FOR UPDATE`, durable across cleanup/cascade/retry/stale/restart, 3-way balanced, capacity filling when a queue empty, worker identity cannot bias.

M8.7 safety unchanged, automation OFF, live execution impossible.
