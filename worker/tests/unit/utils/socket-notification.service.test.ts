/**
 * Unit tests: worker socket-notification stub (`sendSocketNotification`).
 *
 * The worker has no Socket.io instance (CLAUDE.md: the socket path is a stub). The function
 * is currently not called from anywhere in the worker; these tests pin its behaviour so the
 * latent defect below is visible before anything starts depending on it.
 */
import { describe, expect, it } from 'vitest';

import { sendSocketNotification } from '@/app/utils/socket-notification.service';

const payload = { type: 'ride', title: 'T', message: 'M' };

describe('sendSocketNotification', () => {
  // BUG-REPORT WRK-1 | low | worker/src/app/utils/socket-notification.service.ts:16
  // `getIO` is called but never imported or declared (hidden by `// @ts-ignore`), so every call
  // throws `ReferenceError: getIO is not defined` instead of taking the `if (!io)` branch.
  // Fix: remove the call or import a real accessor, and return { success: false } when no io.
  it.fails('BUG WRK-1: resolves { success: false } when no socket server is available, instead of throwing', async () => {
    await expect(sendSocketNotification('user-1', payload)).resolves.toEqual({ success: false });
  });

  it('CHARACTERIZATION: currently rejects with a ReferenceError because getIO is undefined', async () => {
    await expect(sendSocketNotification('user-1', payload)).rejects.toThrow(ReferenceError);
  });
});
