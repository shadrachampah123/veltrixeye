import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SCHEDULED_MAX_REQUESTS_PER_CYCLE,
  DEFAULT_SCHEDULED_MIN_INTERVAL_MS,
} from '@veltrixeye/core';
import { loadConfig } from '../src/config.js';

const base = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://test:test@127.0.0.1:5432/test',
};

function scheduledConfig(env: NodeJS.ProcessEnv = base) {
  return loadConfig(env).scheduledIngestion;
}

test('scheduled ingestion guard config uses the core defaults', () => {
  assert.equal(DEFAULT_SCHEDULED_MAX_REQUESTS_PER_CYCLE, 8);
  assert.equal(DEFAULT_SCHEDULED_MIN_INTERVAL_MS, 900_000);
  assert.deepEqual(scheduledConfig(), {
    enabled: false,
    lookbackCandles: 500,
    maxRequestsPerCycle: DEFAULT_SCHEDULED_MAX_REQUESTS_PER_CYCLE,
    minIntervalMs: DEFAULT_SCHEDULED_MIN_INTERVAL_MS,
  });
});

test('scheduled ingestion guard config accepts valid custom values', () => {
  assert.deepEqual(
    scheduledConfig({
      ...base,
      INGESTION_MAX_REQUESTS_PER_CYCLE: '37',
      INGESTION_MIN_INTERVAL_MS: '1200000',
    }),
    {
      enabled: false,
      lookbackCandles: 500,
      maxRequestsPerCycle: 37,
      minIntervalMs: 1_200_000,
    },
  );
});

for (const empty of ['', '   ']) {
  test(`scheduled ingestion guard config treats ${JSON.stringify(empty)} as unset`, () => {
    assert.deepEqual(
      scheduledConfig({
        ...base,
        INGESTION_MAX_REQUESTS_PER_CYCLE: empty,
        INGESTION_MIN_INTERVAL_MS: empty,
      }),
      {
        enabled: false,
        lookbackCandles: 500,
        maxRequestsPerCycle: DEFAULT_SCHEDULED_MAX_REQUESTS_PER_CYCLE,
        minIntervalMs: DEFAULT_SCHEDULED_MIN_INTERVAL_MS,
      },
    );
  });
}

for (const [variable, value] of [
  ['INGESTION_MAX_REQUESTS_PER_CYCLE', '0'],
  ['INGESTION_MAX_REQUESTS_PER_CYCLE', '1001'],
  ['INGESTION_MIN_INTERVAL_MS', '-1'],
  ['INGESTION_MIN_INTERVAL_MS', '86400001'],
] as const) {
  test(`${variable} rejects the out-of-range value ${value}`, () => {
    assert.throws(
      () => scheduledConfig({ ...base, [variable]: value }),
      new RegExp(variable),
    );
  });
}
