/**
 * Unit and integration tests for the API startup reliability helpers.
 *
 * `probeSocket` is tested deterministically with an injectable `connect` (fake
 * socket) so the timeout and cleanup paths are proven without a real hanging
 * network. `waitForDatabase` and `timePhase` are tested against real local
 * TCP servers and a capturing logger — no production database is contacted.
 * `sanitizeErrorMessage` is tested with deliberately sensitive error messages
 * to prove credentials, connection strings and tokens cannot leak into logs.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import pg from 'pg';
import {
  waitForDatabase,
  timePhase,
  probeSocket,
  parseProbeTarget,
  logFatalBootError,
  sanitizeErrorMessage,
  type StartupLogger,
} from '../src/startup.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ServerHandle {
  port: number;
  openSockets: Set<net.Socket>;
  close: () => Promise<void>;
}

/** A TCP server that tracks open sockets. `handler` optionally acts on them. */
function startServer(port = 0, handler?: (socket: net.Socket) => void): Promise<ServerHandle> {
  const openSockets = new Set<net.Socket>();
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      openSockets.add(socket);
      const drop = () => openSockets.delete(socket);
      socket.on('close', drop);
      socket.on('error', drop);
      if (handler) handler(socket);
    });
    server.listen(port, '127.0.0.1', () => {
      const actualPort = (server.address() as net.AddressInfo).port;
      resolve({
        port: actualPort,
        openSockets,
        close: () =>
          new Promise<void>((r) => {
            for (const s of openSockets) s.destroy();
            server.close(() => r());
          }),
      });
    });
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

function capturingLogger(): { logger: StartupLogger; lines: string[] } {
  const lines: string[] = [];
  const logger: StartupLogger = {
    info: (message) => lines.push(`INFO ${message}`),
    error: (message) => lines.push(`ERROR ${message}`),
  };
  return { logger, lines };
}

/** A minimal fake socket compatible with the parts of `net.Socket` we use. */
class FakeSocket extends EventEmitter {
  destroyed = false;
  destroy(): void {
    this.destroyed = true;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// probeSocket — bounded, safely cleaned up
// ---------------------------------------------------------------------------

describe('probeSocket', () => {
  test('resolves and destroys the socket on a successful connect', async () => {
    const socket = new FakeSocket();
    const connect = () => {
      setTimeout(() => socket.emit('connect'), 0);
      return socket as unknown as net.Socket;
    };
    await probeSocket({ host: '127.0.0.1', port: 1 }, 1000, connect);
    assert.equal(socket.destroyed, true, 'socket must be destroyed after success');
  });

  test('times out, rejects, and destroys the socket when connect never settles', async () => {
    const socket = new FakeSocket();
    const connect = () => socket as unknown as net.Socket; // never emits
    await assert.rejects(
      () => probeSocket({ host: '127.0.0.1', port: 1 }, 20, connect),
      (err: Error) => {
        assert.match(err.message, /timed out after 20ms/);
        return true;
      },
    );
    assert.equal(socket.destroyed, true, 'socket must be destroyed after a timeout');
  });

  test('rejects and destroys the socket on a connection error', async () => {
    const socket = new FakeSocket();
    const connect = () => {
      setTimeout(() => socket.emit('error', new Error('ECONNREFUSED')), 0);
      return socket as unknown as net.Socket;
    };
    await assert.rejects(
      () => probeSocket({ host: '127.0.0.1', port: 1 }, 1000, connect),
      (err: Error) => {
        assert.match(err.message, /ECONNREFUSED/);
        return true;
      },
    );
    assert.equal(socket.destroyed, true, 'socket must be destroyed after an error');
  });
});

// ---------------------------------------------------------------------------
// sanitizeErrorMessage — secret-safe redaction
// ---------------------------------------------------------------------------

describe('parseProbeTarget', () => {
  test('TCP with an explicit port', () => {
    assert.deepEqual(parseProbeTarget('postgres://u:p@127.0.0.1:5433/db'), {
      host: '127.0.0.1',
      port: 5433,
    });
  });

  test('TCP with no port defaults to 5432', () => {
    assert.deepEqual(parseProbeTarget('postgres://u:p@db.internal/db'), {
      host: 'db.internal',
      port: 5432,
    });
  });

  test('Unix domain socket via the host query parameter (correct libpq form)', () => {
    // The socket directory arrives via ?host=; the pathname is the database.
    const target = parseProbeTarget('postgres://u:p@/dbname?host=/var/run/postgresql');
    assert.deepEqual(target, { path: '/var/run/postgresql/.s.PGSQL.5432' });
  });

  test('Unix domain socket honours an explicit port', () => {
    const target = parseProbeTarget('postgres://u:p@/dbname?host=/tmp&port=6000');
    assert.deepEqual(target, { path: '/tmp/.s.PGSQL.6000' });
  });

  test('bare postgres:///dbname (no host, no socket dir) is unsupported', () => {
    // The pathname is the database, not a socket path — nothing to probe.
    assert.equal(parseProbeTarget('postgres:///dbname'), null);
  });

  test('a pathname mistaken for a socket path is NOT treated as a socket', () => {
    // This parses as host="" with database="var/run/postgresql/.s.PGSQL.5432";
    // we must not claim it is a Unix socket.
    assert.equal(parseProbeTarget('postgres:///var/run/postgresql/.s.PGSQL.5432'), null);
  });

  test('empty and undefined connection strings are unsupported', () => {
    assert.equal(parseProbeTarget(''), null);
    assert.equal(parseProbeTarget(undefined), null);
  });

  test('an invalid port is unsupported', () => {
    assert.equal(parseProbeTarget('postgres://u:p@host:notaport/db'), null);
  });
});

describe('sanitizeErrorMessage', () => {
  test('redacts a full connection string with embedded credentials', () => {
    const out = sanitizeErrorMessage(
      'connect failed: postgres://admin:s3cr3tP@ss@db.internal:5432/prod',
    );
    assert.equal(out.includes('postgres://'), false);
    assert.equal(out.includes('s3cr3tP@ss'), false);
    assert.equal(out.includes('admin'), false);
    assert.equal(out.includes('db.internal'), false);
    assert.match(out, /redacted:connection-string/);
  });

  test('redacts credential key/value pairs (password, token, secret, api key)', () => {
    const out = sanitizeErrorMessage(
      'auth failed password=hunter2 token=abc123xyz secret=topsecret api_key=sk-live-999',
    );
    assert.equal(out.includes('hunter2'), false);
    assert.equal(out.includes('abc123xyz'), false);
    assert.equal(out.includes('topsecret'), false);
    assert.equal(out.includes('sk-live-999'), false);
    assert.match(out, /password=\[redacted\]/);
    assert.match(out, /token=\[redacted\]/);
    assert.match(out, /secret=\[redacted\]/);
    assert.match(out, /api_key=\[redacted\]/);
  });

  test('redacts bearer tokens', () => {
    const out = sanitizeErrorMessage('upstream returned Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload');
    assert.equal(out.includes('eyJhbGciOiJIUzI1NiJ9.payload'), false);
    assert.match(out, /Bearer \[redacted\]/);
  });

  test('redacts colon-separated credentials and usernames', () => {
    const out = sanitizeErrorMessage('login user:alice password:letmein123');
    assert.equal(out.includes('letmein123'), false);
    assert.equal(out.includes('alice'), false);
  });

  test('preserves benign diagnostic text unchanged', () => {
    const out = sanitizeErrorMessage('connect ECONNREFUSED 127.0.0.1:5432');
    assert.equal(out, 'connect ECONNREFUSED 127.0.0.1:5432');
  });

  test('falls back to a generic message when nothing safe remains', () => {
    const out = sanitizeErrorMessage('postgres://u:p@h:5432/db');
    assert.notEqual(out, '');
    assert.equal(out.includes('postgres://'), false);
  });
});

// ---------------------------------------------------------------------------
// waitForDatabase
// ---------------------------------------------------------------------------

describe('waitForDatabase', () => {
  test('succeeds on the first attempt against a reachable server', async () => {
    const { logger, lines } = capturingLogger();
    const server = await startServer();
    const pool = new pg.Pool({ connectionString: `postgres://u:p@127.0.0.1:${server.port}/db`, max: 2 });
    try {
      const result = await waitForDatabase(pool, 3, { probeTimeoutMs: 500, sleepMs: 1 }, logger);
      assert.equal(result.attemptsUsed, 1);
      assert.ok(result.elapsedMs >= 0);
      assert.equal(lines.some((l) => l.includes('database ready after')), false);
    } finally {
      await pool.end().catch(() => {});
      await server.close();
    }
    // The probe socket was destroyed: nothing leaks on the server side. Let
    // the server-side 'close' event propagate before asserting.
    await sleep(50);
    assert.equal(server.openSockets.size, 0, 'probe socket was not cleaned up');
  });

  test('probes a Unix domain socket via the host query parameter', async () => {
    const { logger, lines } = capturingLogger();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'veltrix-unix-'));
    const port = 5432; // default port → socket file .s.PGSQL.5432
    const socketPath = path.join(dir, `.s.PGSQL.${port}`);
    const openSockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      openSockets.add(socket);
      const drop = () => openSockets.delete(socket);
      socket.on('close', drop);
      socket.on('error', drop);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ path: socketPath }, resolve);
    });
    // Correct libpq form: socket directory via ?host=, pathname is the db.
    const pool = new pg.Pool({
      connectionString: `postgres://u:p@/dbname?host=${dir}`,
      max: 2,
    });
    try {
      const result = await waitForDatabase(pool, 3, { probeTimeoutMs: 500, sleepMs: 1 }, logger);
      assert.equal(result.attemptsUsed, 1);
      assert.equal(lines.some((l) => l.includes('database ready after')), false);
    } finally {
      await pool.end().catch(() => {});
      await new Promise<void>((r) => server.close(() => r()));
    }
    // The probe socket was destroyed: nothing leaks on the server side.
    await sleep(50);
    assert.equal(openSockets.size, 0, 'probe socket was not cleaned up');
    rmSync(dir, { recursive: true, force: true });
  });

  test('retries through connection delays and succeeds once the server is up', async () => {
    const { logger, lines } = capturingLogger();
    const port = await freePort();
    const pool = new pg.Pool({ connectionString: `postgres://u:p@127.0.0.1:${port}/db`, max: 2 });
    const holder: { server: ServerHandle | null } = { server: null };
    try {
      // The port is free (no server) for the first attempts; start listening
      // shortly after so a later attempt connects.
      setTimeout(async () => {
        holder.server = await startServer(port);
      }, 120);
      const result = await waitForDatabase(pool, 10, { probeTimeoutMs: 100, sleepMs: 30 }, logger);
      assert.ok(result.attemptsUsed >= 2, `expected retries, got ${result.attemptsUsed}`);
      assert.ok(lines.some((l) => l.includes(`database ready after ${result.attemptsUsed} attempt(s)`)));
    } finally {
      await pool.end().catch(() => {});
      await holder.server?.close().catch(() => {});
    }
  });

  test('throws a phase-specific error, ends the pool, and does not hang on failure', async () => {
    const { logger, lines } = capturingLogger();
    // A port with no listener: every probe fails fast with ECONNREFUSED.
    const port = await freePort();
    const pool = new pg.Pool({ connectionString: `postgres://u:p@127.0.0.1:${port}/db`, max: 2 });
    try {
      const outcome = await Promise.race([
        waitForDatabase(pool, 2, { probeTimeoutMs: 100, sleepMs: 1 }, logger).then(
          () => 'resolved',
          () => 'rejected',
        ),
        sleep(3000).then(() => 'HUNG'),
      ]);
      assert.equal(outcome, 'rejected', 'waitForDatabase (incl. pool.end) must not hang');
      assert.equal(pool.ended, true, 'the pool is ended on final failure');
      assert.ok(lines.some((l) => l.includes('attempt 2/2')));
    } finally {
      await pool.end().catch(() => {});
    }
  });

  test('logs are secret-free: no connection string or credential is emitted', async () => {
    const { logger, lines } = capturingLogger();
    const port = await freePort();
    const pool = new pg.Pool({ connectionString: `postgres://user:secret@127.0.0.1:${port}/db`, max: 2 });
    try {
      await waitForDatabase(pool, 1, { probeTimeoutMs: 100, sleepMs: 1 }, logger).catch(() => {});
    } finally {
      await pool.end().catch(() => {});
    }
    const joined = lines.join('\n');
    assert.equal(joined.includes('postgres://'), false);
    assert.equal(joined.includes('password='), false);
    assert.equal(joined.includes('secret'), false);
    assert.ok(joined.includes('[startup]'));
  });

  test('respects the overall deadline and clamps per-attempt probe timeouts', async () => {
    const { logger } = capturingLogger();
    const pool = new pg.Pool({ connectionString: 'postgres://u:p@127.0.0.1:1/db', max: 1 });
    const timeouts: number[] = [];
    const start = Date.now();
    try {
      // A probe that "hangs" until its (clamped) timeout, simulating a
      // black-hole host. The per-attempt timeout must be clamped to the
      // remaining overall budget and the whole wait must stop at the deadline.
      await assert.rejects(
        () =>
          waitForDatabase(
            pool,
            30,
            {
              probeTimeoutMs: 5_000,
              sleepMs: 1_000,
              totalTimeoutMs: 120,
              probeFn: (timeoutMs) => {
                timeouts.push(timeoutMs);
                return new Promise<void>((_resolve, reject) =>
                  setTimeout(() => reject(new Error('probe timed out')), timeoutMs),
                );
              },
            },
            logger,
          ),
        (err: Error) => {
          assert.match(err.message, /Timed out waiting for the database/);
          assert.match(err.message, /deadline 120ms/);
          return true;
        },
      );
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 2_000, `should be bounded by the deadline, took ${elapsed}ms`);
      assert.equal(pool.ended, true, 'the pool is ended on deadline failure');
      assert.ok(timeouts.length >= 1);
      assert.ok(
        Math.max(...timeouts) <= 120,
        `probe timeout ${Math.max(...timeouts)} exceeded the overall deadline`,
      );
    } finally {
      await pool.end().catch(() => {});
    }
  });

  test('clamps retry sleeps to the overall deadline', async () => {
    const { logger } = capturingLogger();
    const pool = new pg.Pool({ connectionString: 'postgres://u:p@127.0.0.1:1/db', max: 1 });
    const start = Date.now();
    try {
      // Probes fail fast; the large sleepMs must be clamped so the wait is
      // still bounded by the overall deadline.
      await assert.rejects(
        () =>
          waitForDatabase(
            pool,
            30,
            {
              probeTimeoutMs: 1,
              sleepMs: 10_000,
              totalTimeoutMs: 150,
              probeFn: () => Promise.reject(new Error('ECONNREFUSED')),
            },
            logger,
          ),
        (err: Error) => {
          assert.match(err.message, /Timed out waiting for the database/);
          return true;
        },
      );
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 2_000, `sleep must be clamped to the deadline, took ${elapsed}ms`);
      assert.equal(pool.ended, true, 'the pool is ended on deadline failure');
    } finally {
      await pool.end().catch(() => {});
    }
  });

  test('terminates on exhausted attempts (not the deadline) and ends the pool', async () => {
    const { logger } = capturingLogger();
    const pool = new pg.Pool({ connectionString: 'postgres://u:p@127.0.0.1:1/db', max: 1 });
    let calls = 0;
    try {
      // A generous deadline: termination is driven by the attempt count, not
      // the deadline, so the error must report exhausted attempts.
      await assert.rejects(
        () =>
          waitForDatabase(
            pool,
            3,
            {
              probeTimeoutMs: 1,
              sleepMs: 1,
              totalTimeoutMs: 10_000,
              probeFn: () => {
                calls += 1;
                return Promise.reject(new Error('ECONNREFUSED'));
              },
            },
            logger,
          ),
        (err: Error) => {
          assert.match(err.message, /Could not connect to the database after 3 attempt/);
          assert.equal(err.message.includes('Timed out'), false);
          return true;
        },
      );
      assert.equal(calls, 3, 'exactly the requested attempts are attempted');
      assert.equal(pool.ended, true, 'the pool is ended on failure');
    } finally {
      await pool.end().catch(() => {});
    }
  });

  test('succeeds within the overall deadline and reports timedOut=false', async () => {
    const { logger } = capturingLogger();
    const pool = new pg.Pool({ connectionString: 'postgres://u:p@127.0.0.1:1/db', max: 1 });
    let calls = 0;
    try {
      const result = await waitForDatabase(
        pool,
        10,
        {
          probeTimeoutMs: 1_000,
          sleepMs: 1,
          totalTimeoutMs: 10_000,
          probeFn: () => {
            calls += 1;
            return calls >= 2 ? Promise.resolve() : Promise.reject(new Error('not yet'));
          },
        },
        logger,
      );
      assert.equal(result.attemptsUsed, 2);
      assert.equal(result.timedOut, false);
      assert.ok(result.elapsedMs >= 0);
      assert.equal(calls, 2);
    } finally {
      await pool.end().catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// timePhase — timing and sanitized failure reporting
// ---------------------------------------------------------------------------

describe('timePhase', () => {
  test('logs start and completion with a duration and returns the value', async () => {
    const { logger, lines } = capturingLogger();
    const result = await timePhase('test-phase', async () => 42, logger);
    assert.equal(result, 42);
    assert.ok(lines.some((l) => l === 'INFO [startup] test-phase start'));
    assert.ok(lines.some((l) => /INFO \[startup\] test-phase done in \d+ms/.test(l)));
  });

  test('logs a phase-specific failure with duration and rethrows', async () => {
    const { logger, lines } = capturingLogger();
    await assert.rejects(
      () => timePhase('migrations', async () => { throw new Error('boom'); }, logger),
      (err: Error) => {
        assert.equal(err.message, 'boom');
        return true;
      },
    );
    assert.ok(lines.some((l) => l === 'INFO [startup] migrations start'));
    assert.ok(
      lines.some((l) => /ERROR \[startup\] migrations FAILED after \d+ms: boom/.test(l)),
      `expected a phase-specific failure line, got: ${lines.join(' | ')}`,
    );
  });

  test('sanitizes failure logging: message only, never the raw error or stack', async () => {
    const { logger, lines } = capturingLogger();
    const secretError = new Error('disk on fire');
    // A realistic error carries a multi-frame stack; it must not be logged.
    assert.ok(secretError.stack && secretError.stack.includes('at '));
    await assert.rejects(() => timePhase('listen', async () => { throw secretError; }, logger));
    const failure = lines.find((l) => l.startsWith('ERROR [startup] listen FAILED'));
    assert.ok(failure, 'expected a failure line');
    assert.match(failure, /disk on fire/);
    // No raw error object, no stack frames, no "Error:" dump.
    assert.equal(failure.includes('at '), false, 'stack frames must not be logged');
    assert.equal(failure.includes('Error: disk on fire'), false, 'raw error dump must not be logged');
  });

  test('redacts sensitive values from a phase failure message end-to-end', async () => {
    const { logger, lines } = capturingLogger();
    const sensitive = new Error(
      'connection failed: postgres://admin:hunter2@db.host:5432/prod password=letmein',
    );
    await assert.rejects(() => timePhase('db-connect', async () => { throw sensitive; }, logger));
    const failure = lines.find((l) => l.startsWith('ERROR [startup] db-connect FAILED'));
    assert.ok(failure, 'expected a failure line');
    assert.equal(failure.includes('hunter2'), false, 'credential must not leak');
    assert.equal(failure.includes('letmein'), false, 'credential must not leak');
    assert.equal(failure.includes('postgres://'), false, 'connection string must not leak');
    assert.equal(failure.includes('db.host'), false, 'host from connection string must not leak');
    assert.match(failure, /redacted/);
  });
});

// ---------------------------------------------------------------------------
// logFatalBootError — top-level fatal handler is secret-safe
// ---------------------------------------------------------------------------

describe('logFatalBootError', () => {
  test('logs a single sanitized line and never the raw error or stack', () => {
    const { logger, lines } = capturingLogger();
    const err = new Error('fatal: connect failed postgres://admin:hunter2@db.host:5432/prod');
    // A realistic error carries a multi-frame stack.
    assert.ok(err.stack && err.stack.includes('at '));
    logFatalBootError(err, logger);
    assert.equal(lines.length, 1, 'exactly one fatal log line');
    const line = lines[0];
    assert.ok(line, 'expected a fatal log line');
    assert.match(line, /\[api\] fatal boot error:/);
    // No credential, no connection string, no host from the string.
    assert.equal(line.includes('hunter2'), false);
    assert.equal(line.includes('postgres://'), false);
    assert.equal(line.includes('admin'), false);
    assert.equal(line.includes('db.host'), false);
    // No raw error dump, no stack frames.
    assert.equal(line.includes('Error:'), false);
    assert.equal(line.includes('at '), false);
    // Single line.
    assert.equal(line.includes('\n'), false);
    assert.match(line, /redacted/);
  });

  test('redacts key/value credentials from a non-Error thrown value', () => {
    const { logger, lines } = capturingLogger();
    logFatalBootError('boot failed password=letmein token=abc123', logger);
    const line = lines[0];
    assert.ok(line, 'expected a fatal log line');
    assert.equal(line.includes('letmein'), false);
    assert.equal(line.includes('abc123'), false);
    assert.match(line, /password=\[redacted\]/);
    assert.match(line, /token=\[redacted\]/);
  });

  test('handles an error with no message gracefully', () => {
    const { logger, lines } = capturingLogger();
    logFatalBootError(new Error(''), logger);
    assert.equal(lines.length, 1);
    const line = lines[0];
    assert.ok(line, 'expected a fatal log line');
    assert.match(line, /\[api\] fatal boot error: /);
  });
});
