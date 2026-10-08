/**
 * Client wait-time notice: warning only — does NOT charge or change fare.
 * Automatic EUR 20 delay fee is deferred to a later phase.
 */
export const WAIT_NOTICE_FEE_AMOUNT_EUR = 20;
export const WAIT_NOTICE_MAX_MINUTES = 5;
export const WAIT_NOTICE_THRESHOLD_SECONDS = WAIT_NOTICE_MAX_MINUTES * 60;

export const WAIT_NOTICE_MESSAGE =
  `Please be ready when your driver arrives. Delays of more than ${WAIT_NOTICE_MAX_MINUTES} minutes ` +
  `may result in a EUR ${WAIT_NOTICE_FEE_AMOUNT_EUR} waiting-time fee. ` +
  'This helps avoid disruption to other riders sharing the journey.';

export const WAIT_NOTICE_FOLLOW_UP_MESSAGE =
  `Your driver has been waiting for ${WAIT_NOTICE_MAX_MINUTES} minutes. Please board now. ` +
  `Further delays may result in a EUR ${WAIT_NOTICE_FEE_AMOUNT_EUR} waiting-time fee.`;

export const buildWaitTimeNotice = (stage: 'initial' | 'follow_up' = 'initial') => ({
  mode: 'warning_only' as const,
  stage,
  feeAmount: WAIT_NOTICE_FEE_AMOUNT_EUR,
  dummyWarningAmount: WAIT_NOTICE_FEE_AMOUNT_EUR,
  currency: 'EUR',
  maxWaitMinutes: WAIT_NOTICE_MAX_MINUTES,
  chargeApplied: false,
  affectsPrice: false,
  message: stage === 'follow_up' ? WAIT_NOTICE_FOLLOW_UP_MESSAGE : WAIT_NOTICE_MESSAGE,
});

/** Delay strictly greater than 5:00 after driver arrival counts as exceeded. */
export const computePickupDelay = (
  arriveAt?: Date | string | null,
  pickedUpAt: Date = new Date(),
): { pickupDelaySeconds: number | null; waitThresholdExceeded: boolean } => {
  if (!arriveAt) return { pickupDelaySeconds: null, waitThresholdExceeded: false };
  const arrivedMs = new Date(arriveAt).getTime();
  if (!Number.isFinite(arrivedMs)) {
    return { pickupDelaySeconds: null, waitThresholdExceeded: false };
  }
  const pickupDelaySeconds = Math.max(0, Math.floor((pickedUpAt.getTime() - arrivedMs) / 1000));
  return {
    pickupDelaySeconds,
    waitThresholdExceeded: pickupDelaySeconds > WAIT_NOTICE_THRESHOLD_SECONDS,
  };
};
