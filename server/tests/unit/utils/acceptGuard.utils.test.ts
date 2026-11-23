/**
 * Client QA round 3, issue 14: a split rider's booking was REFUNDED, yet the
 * driver could still accept, pick up and complete that rider (who kept the
 * refund). The accept handler had no state checks. These guards close it.
 */
import { describe, expect, it } from 'vitest';
import {
  ACCEPT_BLOCKED_MESSAGE,
  getAcceptBlockReason,
  isClosedForPayment,
} from '@src/app/utils/acceptGuard.utils';

describe('getAcceptBlockReason', () => {
  it('normal pending / resumed passengers can be accepted', () => {
    expect(getAcceptBlockReason({ status: 'pending' }, { bookingStatus: 'pending', paymentStatus: 'authorized' })).toBeNull();
    expect(getAcceptBlockReason({ status: 'confirmed' }, { bookingStatus: 'accepted', paymentStatus: 'paid' })).toBeNull();
    expect(getAcceptBlockReason({ status: 'pending' }, { bookingStatus: 'pending', paymentStatus: 'paid' })).toBeNull();
    expect(getAcceptBlockReason({ status: 'pending' }, { bookingStatus: 'pending', paymentStatus: 'requires_reauthorization' })).toBeNull();
  });

  it.each(['cancelled', 'rejected', 'completed'])('blocks a %s passenger', (status) => {
    expect(getAcceptBlockReason({ status }, { bookingStatus: 'pending', paymentStatus: 'authorized' })).toBe(ACCEPT_BLOCKED_MESSAGE);
  });

  it.each(['cancelled', 'rejected', 'completed'])('blocks a %s booking', (bookingStatus) => {
    expect(getAcceptBlockReason({ status: 'pending' }, { bookingStatus, paymentStatus: 'authorized' })).toBe(ACCEPT_BLOCKED_MESSAGE);
  });

  it.each(['refunded', 'cancelled_authorization'])('blocks a booking whose payment is %s', (paymentStatus) => {
    expect(getAcceptBlockReason({ status: 'pending' }, { bookingStatus: 'pending', paymentStatus })).toBe(ACCEPT_BLOCKED_MESSAGE);
  });
});

describe('isClosedForPayment', () => {
  it('open bookings can be paid', () => {
    expect(isClosedForPayment({ bookingStatus: 'pending', paymentStatus: 'pending' }, { status: 'pending' })).toBe(false);
    // A released hold (e.g. after a failed capture) may be paid again while the booking is open.
    expect(isClosedForPayment({ bookingStatus: 'pending', paymentStatus: 'cancelled_authorization' }, { status: 'pending' })).toBe(false);
  });

  it('cancelled / refunded bookings or passengers can not', () => {
    expect(isClosedForPayment({ bookingStatus: 'cancelled', paymentStatus: 'pending' }, null)).toBe(true);
    expect(isClosedForPayment({ bookingStatus: 'pending', paymentStatus: 'refunded' }, null)).toBe(true);
    expect(isClosedForPayment({ bookingStatus: 'pending', paymentStatus: 'pending' }, { status: 'cancelled' })).toBe(true);
  });
});
