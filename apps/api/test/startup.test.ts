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
import net from 'node:net';

import pg from 'pg';
import {
  waitForDatabase,
  timePhase,
  probeSocket,
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
