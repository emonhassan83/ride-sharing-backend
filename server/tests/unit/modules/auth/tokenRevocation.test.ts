/**
 * Issue 15 follow-up: logout must end the session on the server, not only on the phone.
 *
 * Before: access tokens lived 30 days and were never revoked. An app (or anyone) that
 * kept the old token could keep calling the API and reconnect the socket after logout.
 * Now logout stamps `user.tokensValidAfter`; tokens issued before it are rejected by the
 * REST `auth` middleware, the socket handshake and the refresh endpoint.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';

vi.mock('@src/app/modules/user/user.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { User: createModelMock() };
});
vi.mock('@src/app/modules/vehicle/vehicle.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Vehicle: createModelMock() };
});

import auth from '@src/app/middlewares/auth';
import { createToken, isTokenRevoked, SESSION_ENDED_MESSAGE } from '@src/app/modules/auth/auth.utils';
import { User } from '@src/app/modules/user/user.model';
import { socketAuth } from '@src/app/socket/utils/socket.auth';
import { mockReq, mockRes } from '@tests/helpers/express';
import { mockQuery, oid } from '@tests/helpers/mongoose';
import { translateText } from '@src/app/i18n/i18n';

const SECRET = 'test-access-secret'; // vitest.config.mts JWT_ACCESS_SECRET
const userId = oid();
const issue = () => createToken({ userId, email: 'd@test.local', role: 'provider' }, SECRET, '1h');

describe('isTokenRevoked', () => {
  const at = (iso: string) => new Date(iso);

  it('never revoked when the user never logged out', () => {
    expect(isTokenRevoked({ iatMs: 1 }, null)).toBe(false);
    expect(isTokenRevoked({ iatMs: 1 }, undefined)).toBe(false);
  });

  it('a token issued before logout is revoked; one issued after is valid', () => {
    const logout = at('2026-11-23T10:00:00.500Z');
    expect(isTokenRevoked({ iatMs: logout.getTime() - 1 }, logout)).toBe(true);
    expect(isTokenRevoked({ iatMs: logout.getTime() + 1 }, logout)).toBe(false);
  });

  it('re-login in the SAME second as logout stays valid (millisecond precision)', () => {
    const logout = at('2026-11-23T10:00:00.400Z');
    const relogin = { iat: Math.floor(Date.parse('2026-11-23T10:00:00.900Z') / 1000), iatMs: Date.parse('2026-11-23T10:00:00.900Z') };
    expect(isTokenRevoked(relogin, logout)).toBe(false);
  });

  it('old tokens without iatMs fall back to the JWT iat (seconds)', () => {
    const logout = at('2026-11-23T10:00:00Z');
    expect(isTokenRevoked({ iat: Date.parse('2026-11-22T10:00:00Z') / 1000 }, logout)).toBe(true);
    expect(isTokenRevoked({ iat: Date.parse('2026-11-24T10:00:00Z') / 1000 }, logout)).toBe(false);
  });

  it('createToken stamps a millisecond issue time', () => {
    const before = Date.now();
    const decoded = jwt.decode(issue()) as any;
    expect(decoded.iatMs).toBeGreaterThanOrEqual(before);
    expect(decoded.iatMs).toBeLessThanOrEqual(Date.now());
  });

  it('the message is translated in every language', () => {
    for (const lang of ['el', 'he', 'ru', 'uk']) {
      expect(translateText(SESSION_ENDED_MESSAGE, lang)).not.toBe(SESSION_ENDED_MESSAGE);
    }
  });
});

describe('REST auth middleware', () => {
  const run = async (token: string) => {
    const req = mockReq({ method: 'GET', headers: { authorization: `Bearer ${token}` }, params: {} });
    const next = vi.fn();
    await (auth('common') as any)(req, mockRes(), next);
    return next;
  };

  beforeEach(() => {
    vi.mocked(User.findByIdAndUpdate).mockReturnValue(mockQuery(null) as any);
  });

  it('rejects a token issued before the last logout with 401', async () => {
    const token = issue();
    vi.mocked(User.findById).mockReturnValue(
      mockQuery({ _id: userId, role: 'provider', status: 'active', tokensValidAfter: new Date(Date.now() + 1000) }) as any,
    );

    const next = await run(token);

    const err = next.mock.calls[0][0];
    expect(err?.code).toBe(401);
    expect(err?.message).toBe(SESSION_ENDED_MESSAGE);
  });

  it('accepts a token issued after the last logout', async () => {
    vi.mocked(User.findById).mockReturnValue(
      mockQuery({ _id: userId, role: 'provider', status: 'active', tokensValidAfter: new Date(Date.now() - 1000) }) as any,
    );

    const next = await run(issue());

    expect(next).toHaveBeenCalledWith();
  });
});

describe('socket handshake (socketAuth)', () => {
  const handshake = async (token: string) => {
    const socket: any = { handshake: { auth: { token }, headers: {} } };
    const next = vi.fn();
    await socketAuth(socket, next);
    return { socket, next };
  };

  it('refuses to reconnect with a token from before logout', async () => {
    const token = issue();
    vi.mocked(User.findById).mockReturnValue(
      mockQuery({ _id: userId, role: 'user', tokensValidAfter: new Date(Date.now() + 1000) }) as any,
    );

    const { next } = await handshake(token);

    expect(next.mock.calls[0][0]?.message).toBe(SESSION_ENDED_MESSAGE);
  });

  it('lets a fresh token connect', async () => {
    vi.mocked(User.findById).mockReturnValue(
      mockQuery({ _id: userId, role: 'user', tokensValidAfter: new Date(Date.now() - 1000) }) as any,
    );
    vi.mocked(User.findByIdAndUpdate).mockReturnValue(mockQuery(null) as any);

    const { next, socket } = await handshake(issue());

    expect(next).toHaveBeenCalledWith();
    expect(String(socket.auth?._id)).toBe(String(userId));
  });
});
