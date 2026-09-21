/** Client wait-time notice: dummy warning only — does NOT charge or change fare. */
export const WAIT_NOTICE_DUMMY_AMOUNT_EUR = 10;
export const WAIT_NOTICE_MAX_MINUTES = 5;

export const buildWaitTimeNotice = () => ({
  dummyWarningAmount: WAIT_NOTICE_DUMMY_AMOUNT_EUR,
  maxWaitMinutes: WAIT_NOTICE_MAX_MINUTES,
  affectsPrice: false,
  message:
    `Please be ready within ${WAIT_NOTICE_MAX_MINUTES} minutes. ` +
    `Driver cannot wait more than ${WAIT_NOTICE_MAX_MINUTES} minutes at pickup. ` +
    `Note: a €${WAIT_NOTICE_DUMMY_AMOUNT_EUR} wait warning is informational only and does not change your locked upfront price.`,
});
