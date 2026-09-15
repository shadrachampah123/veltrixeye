/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * M6 Phase 3 — the stub alert sender.
 *
 * These are pure unit tests (no database, no HTTP): they pin the delivery
 * boundary so "delivery" in M6 is provably local, deterministic and free of
 * any external I/O.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

import {
  ALERT_PAYLOAD_HASH_RE,
  alertPayloadHash,
  canonicalize,
  NonStubSenderError,
  StubAlertSender,
  type AlertSendRequest,
} from '../src/alerts/sender.js';

const ALERT_ID = '11111111-1111-4111-8111-111111111111';

function request(overrides: Partial<AlertSendRequest> = {}): AlertSendRequest {
  return {
    alertId: ALERT_ID,
    userId: '22222222-2222-4222-8222-222222222222',
    setupId: '33333333-3333-4333-8333-333333333333',
    triggerState: 'confirmed',
    title: 'EURUSD long confirmed (score 82/A)',
    body: {
      setupId: '33333333-3333-4333-8333-333333333333',
      qualityScore: 82,
      qualityGrade: 'A',
      minQualityScore: 65,
      entryPrice: 1.1234,
      triggerState: 'confirmed',
      levels: [1.1234, 1.12, 1.13],
    },
    ...overrides,
  };
}

interface NetCall {
  fn: string;
  target: string;
}

function targetOf(args: any[]): string {
  const first = args[0];
  if (typeof first === 'string') return first;
  if (first instanceof URL) return `${first.hostname}${first.port ? `:${first.port}` : ''}`;
  if (first && typeof first === 'object') {
    const host = first.hostname ?? first.host ?? first.path ?? '';
    const port = first.port ?? '';
    return `${host}${port ? `:${port}` : ''}`;
  }
  return '';
}

/** Spy on every outbound entry point (recording, never blocking). */
async function withNetworkSpy<T>(fn: () => Promise<T>): Promise<{ result: T; calls: NetCall[] }> {
  const calls: NetCall[] = [];
  const restores: Array<() => void> = [];
  function wrap(obj: any, name: string, label: string): void {
    const original = obj[name];
    if (typeof original !== 'function') return;
    obj[name] = function wrapped(...args: any[]) {
      calls.push({ fn: label, target: targetOf(args) });
      return original.apply(this, args);
    };
    restores.push(() => {
      obj[name] = original;
    });
  }
  wrap(globalThis, 'fetch', 'fetch');
  wrap(http, 'request', 'http.request');
  wrap(http, 'get', 'http.get');
  wrap(https, 'request', 'https.request');
  wrap(https, 'get', 'https.get');
  wrap(net, 'connect', 'net.connect');
  wrap(net, 'createConnection', 'net.createConnection');
  wrap(net.Socket.prototype, 'connect', 'net.Socket.connect');
  wrap(tls, 'connect', 'tls.connect');
  wrap(dns, 'lookup', 'dns.lookup');
  wrap(dns.promises, 'lookup', 'dns.promises.lookup');

  try {
    return { result: await fn(), calls };
  } finally {
    for (const restore of restores.reverse()) restore();
  }
}

describe('m6 stub alert sender', () => {
  test('is the local stub channel and records exactly one delivered attempt', async () => {
    const sender = new StubAlertSender();
    assert.equal(sender.channel, 'stub');
    const result = await sender.send(request());
    assert.equal(result.status, 'delivered');
    assert.equal(result.attempt, 1);
    assert.equal(result.error, null);
    assert.match(result.payloadHash, ALERT_PAYLOAD_HASH_RE);
  });

  test('payload hash is the sha256 of the pinned canonical JSON (independent expectation)', async () => {
    const sender = new StubAlertSender();
    const result = await sender.send(request());
    // Constructed by hand from the documented rule: keys sorted at every
    // level, no whitespace, alertId + title + body only.
    const expectedJson =
      `{"alertId":"${ALERT_ID}","body":{"entryPrice":1.1234,"levels":[1.1234,1.12,1.13],` +
      `"minQualityScore":65,"qualityGrade":"A","qualityScore":82,` +
      `"setupId":"33333333-3333-4333-8333-333333333333","triggerState":"confirmed"},` +
      `"title":"EURUSD long confirmed (score 82/A)"}`;
    assert.equal(result.canonicalJson, expectedJson);
    assert.equal(result.payloadHash, createHash('sha256').update(expectedJson, 'utf8').digest('hex'));
  });

  test('hash is stable across calls and across body key ordering', async () => {
    const sender = new StubAlertSender();
    const first = await sender.send(request());
    const second = await sender.send(request());
    assert.equal(first.payloadHash, second.payloadHash);

    const reordered = await sender.send(
      request({
        body: {
          triggerState: 'confirmed',
          levels: [1.1234, 1.12, 1.13],
          entryPrice: 1.1234,
          minQualityScore: 65,
          qualityGrade: 'A',
          qualityScore: 82,
          setupId: '33333333-3333-4333-8333-333333333333',
        },
      }),
    );
    assert.equal(reordered.payloadHash, first.payloadHash);

    // Different meaningful content still differs (no accidental collapse).
    const different = await sender.send(request({ title: 'EURUSD long triggered (score 82/A)' }));
    assert.notEqual(different.payloadHash, first.payloadHash);

    // Arrays are semantically ordered: reordering one IS a different payload.
    const arrayReordered = await sender.send(
      request({ body: { ...request().body, levels: [1.12, 1.1234, 1.13] } }),
    );
    assert.notEqual(arrayReordered.payloadHash, first.payloadHash);
  });

  test('canonicalization sorts keys, preserves arrays and normalizes Dates, without mutating input', () => {
    const input = { b: 1, a: { d: [2, { z: 1, y: 2 }], c: new Date('2026-01-02T03:04:05.000Z') } };
    const canonical = canonicalize(input) as any;
    assert.deepEqual(Object.keys(canonical), ['a', 'b']);
    assert.deepEqual(Object.keys(canonical.a), ['c', 'd']);
    assert.equal(canonical.a.c, '2026-01-02T03:04:05.000Z');
    assert.deepEqual(canonical.a.d, [2, { y: 2, z: 1 }]);
    // The caller's object is untouched (no in-place sorting).
    assert.deepEqual(Object.keys(input), ['b', 'a']);
    assert.ok(input.a.c instanceof Date);
  });

  test('alertPayloadHash always returns a 64-hex sha256', () => {
    const { payloadHash } = alertPayloadHash({
      alertId: ALERT_ID,
      title: 't',
      body: {},
    });
    assert.equal(payloadHash.length, 64);
    assert.match(payloadHash, ALERT_PAYLOAD_HASH_RE);
  });

  test('send performs zero external I/O (no fetch/http/https/tls/dns socket)', async () => {
    const sender = new StubAlertSender();
    const { result, calls } = await withNetworkSpy(() => sender.send(request()));
    assert.equal(result.status, 'delivered');
    assert.deepEqual(calls, [], `unexpected network activity: ${JSON.stringify(calls)}`);
    // Spy liveness: the same recorder DOES see a real socket attempt, so the
    // empty list above is a genuine result, not a broken wrapper.
    const { calls: probeCalls } = await withNetworkSpy(async () => {
      const probe = net.connect({ host: '127.0.0.1', port: 1 });
      probe.on('error', () => {});
      probe.destroy();
    });
    assert.ok(
      probeCalls.some((c) => c.fn === 'net.connect'),
      `network spy recorded no probe: ${JSON.stringify(probeCalls)}`,
    );
  });

  test('refuses a non-stub channel instead of delivering externally', () => {
    const error = new NonStubSenderError('email');
    assert.match(error.message, /stub/);
    assert.match(error.message, /later milestone/);
    assert.equal(error.name, 'NonStubSenderError');
  });
});
