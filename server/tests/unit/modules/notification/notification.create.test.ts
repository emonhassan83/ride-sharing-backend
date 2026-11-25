/**
 * POST /notification was mounted with no auth at all: anyone could create a
 * notification (and its socket emit) for any user. No app, server or worker code
 * calls it, so it is now admin-only and its body is validated (.strict()).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@src/app/modules/user/user.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { User: createModelMock() };
});
vi.mock('@src/app/modules/notification/notification.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Notification: createModelMock() };
});
vi.mock('@src/app/modules/passenger/passenger.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Passenger: createModelMock() };
});
vi.mock('@src/app/modules/booking/booking.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Booking: createModelMock() };
});

import { createToken } from '@src/app/modules/auth/auth.utils';
import { NotificationRoutes } from '@src/app/modules/notification/notification.routes';
import { NotificationValidation } from '@src/app/modules/notification/notification.validation';
import { Notification } from '@src/app/modules/notification/notification.model';
import { User } from '@src/app/modules/user/user.model';
import { mockReq, mockRes } from '@tests/helpers/express';
import { mockQuery, oidStr } from '@tests/helpers/mongoose';

const SECRET = 'test-access-secret'; // vitest.config.mts JWT_ACCESS_SECRET
const callerId = oidStr();
const receiver = oidStr();

/** Runs the handlers registered for `method path` in order, like Express would. */
const runRoute = async (method: string, path: string, req: any) => {
  const layer = (NotificationRoutes as any).stack.find(
    (l: any) => l.route?.path === path && l.route.methods[method.toLowerCase()],
  );
  if (!layer) throw new Error(`route ${method} ${path} not registered`);
  const res = mockRes();
  let error: any;
  for (const { handle } of layer.route.stack) {
    let calledNext = false;
    await new Promise<void>((resolve) => {
      const next = (err?: any) => {
        calledNext = true;
        error = err;
        resolve();
      };
      Promise.resolve(handle(req, res, next)).then(() => setTimeout(resolve, 0));
    });
    if (error || !calledNext) break;
  }
  return { res, error };
};

const asRole = (role: string | null, body: Record<string, unknown>) => {
  const headers: Record<string, string> = {};
  if (role) {
    headers.authorization = `Bearer ${createToken({ userId: callerId as any, email: 'x@test.local', role }, SECRET, '1h')}`;
    vi.mocked(User.findById).mockReturnValue(
      mockQuery({ _id: callerId, role, status: 'active', isDeleted: false, language: 'en' }) as any,
    );
  }
  return mockReq({ method: 'POST', originalUrl: '/api/v1/notification', headers, body });
};

const validBody = { receiver, message: 'Hello' };

beforeEach(() => {
  vi.mocked(Notification.create).mockResolvedValue({ _id: oidStr(), ...validBody } as any);
});

describe('POST /notification auth', () => {
  it('rejects an anonymous request with 401 and creates nothing', async () => {
    const { error } = await runRoute('POST', '/', asRole(null, validBody));

    expect(error?.statusCode ?? error?.code).toBe(401);
    expect(Notification.create).not.toHaveBeenCalled();
  });

  it.each(['user', 'provider'])('rejects a %s with 403 and creates nothing', async (role) => {
    const { error } = await runRoute('POST', '/', asRole(role, validBody));

    expect(error?.statusCode ?? error?.code).toBe(403);
    expect(Notification.create).not.toHaveBeenCalled();
  });

  it('lets an admin create a notification for the given receiver', async () => {
    const { res, error } = await runRoute('POST', '/', asRole('admin', validBody));

    expect(error).toBeUndefined();
    expect(res.statusCode).toBe(201);
    expect(Notification.create).toHaveBeenCalledWith(
      expect.objectContaining({ receiver, message: 'Hello' }),
    );
  });

  it('rejects an admin request with an invalid body before touching the DB', async () => {
    const { error } = await runRoute('POST', '/', asRole('admin', { message: 'no receiver' }));

    expect(error?.name).toBe('ZodError');
    expect(Notification.create).not.toHaveBeenCalled();
  });
});

describe('NotificationValidation.createValidationSchema', () => {
  const parse = (body: unknown) => NotificationValidation.createValidationSchema.safeParse({ body });

  it('accepts the minimal and the full body', () => {
    expect(parse(validBody).success).toBe(true);
    expect(
      parse({
        ...validBody,
        description: 'd',
        reference: oidStr(),
        modelType: 'Ride',
        type: 'promo',
        data: { screen: 'home' },
      }).success,
    ).toBe(true);
  });

  it('requires a valid receiver ObjectId and a non-empty message', () => {
    expect(parse({ message: 'x' }).success).toBe(false);
    expect(parse({ receiver: 'nope', message: 'x' }).success).toBe(false);
    expect(parse({ receiver, message: '   ' }).success).toBe(false);
  });

  it('rejects unknown keys and bad enum / data values', () => {
    expect(parse({ ...validBody, read: true }).success).toBe(false);
    expect(parse({ ...validBody, modelType: 'Nope' }).success).toBe(false);
    expect(parse({ ...validBody, data: { n: 1 } }).success).toBe(false);
  });
});
