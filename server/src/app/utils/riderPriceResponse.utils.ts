import { roundMoney } from './fareMath.utils';

/** Rider-facing price view: Estimated Price + VAT 9% included only. */
export const toRiderPriceView = (input: {
  estimatedFare?: number;
  totalFare?: number;
  vatAmount?: number;
  vatPercentage?: number;
  platformVatPercent?: number;
  vatIncluded?: boolean;
}) => {
  const estimatedFare = roundMoney(
    Number(input.estimatedFare ?? input.totalFare ?? 0),
  );
  const rawVatPercentage = Number(
    input.vatPercentage ?? input.platformVatPercent ?? 9,
  );
  // A configured 0% VAT is valid; only fall back when the value is not a number.
  const vatPercentage = Number.isFinite(rawVatPercentage) ? rawVatPercentage : 9;

  return {
    estimatedFare,
    totalFare: estimatedFare,
    vatIncluded: input.vatIncluded !== false,
    vatPercentage,
    vatAmount: roundMoney(Number(input.vatAmount ?? 0)),
  };
};
