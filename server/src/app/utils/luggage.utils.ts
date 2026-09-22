import { StatusCodes } from 'http-status-codes';
import ApiError from '../errors/ApiError';

/** FYI-only luggage sizes (no fare charge). */
export const LARGE_SUITCASE_SIZE_CM = { length: 75, width: 50, height: 35 } as const;
export const SMALL_SUITCASE_SIZE_4SEATER_CM = { length: 60, width: 40, height: 25 } as const;
export const SMALL_SUITCASE_SIZE_6SEATER_CM = { length: 60, width: 40, height: 26 } as const;

export type LuggageVehicleClass = '4-seater' | '6-seater';

export const LUGGAGE_LIMITS = {
  '4-seater': { maxLarge: 2, maxSmall: 2 },
  '6-seater': { maxLarge: 2, maxSmall: 4 },
} as const;

/** Infer boot class from requested seats (≤4 → E-Class boot, ≥5 → 6-seater). */
export const resolveLuggageVehicleClass = (
  requestedSeats: number,
): LuggageVehicleClass => (Number(requestedSeats) >= 5 ? '6-seater' : '4-seater');

export const getLuggageSizeGuide = (vehicleClass: LuggageVehicleClass) => ({
  vehicleClass,
  largeSuitcaseCm: LARGE_SUITCASE_SIZE_CM,
  smallSuitcaseCm:
    vehicleClass === '6-seater'
      ? SMALL_SUITCASE_SIZE_6SEATER_CM
      : SMALL_SUITCASE_SIZE_4SEATER_CM,
  limits: LUGGAGE_LIMITS[vehicleClass],
  chargeApplies: false,
});

export type NormalizedLuggage = {
  largeSuitcase: number;
  smallSuitcase: number;
  luggageNote: string;
  /** Always 0 — luggage is FYI only, never billed. */
  luggageCounts: number;
  vehicleClass: LuggageVehicleClass;
  sizeGuide: ReturnType<typeof getLuggageSizeGuide>;
};

export const normalizeAndAssertLuggage = (input: {
  largeSuitcase?: number;
  smallSuitcase?: number;
  luggageNote?: string;
  requestedSeats: number;
}): NormalizedLuggage => {
  const largeSuitcase = Math.max(0, Math.floor(Number(input.largeSuitcase) || 0));
  const smallSuitcase = Math.max(0, Math.floor(Number(input.smallSuitcase) || 0));
  const luggageNote = (input.luggageNote ?? '').toString().trim();
  const vehicleClass = resolveLuggageVehicleClass(input.requestedSeats);
  const limits = LUGGAGE_LIMITS[vehicleClass];

  if (largeSuitcase > limits.maxLarge) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      `${vehicleClass} allows maximum ${limits.maxLarge} large suitcase(s) (${LARGE_SUITCASE_SIZE_CM.length}×${LARGE_SUITCASE_SIZE_CM.width}×${LARGE_SUITCASE_SIZE_CM.height} cm).`,
    );
  }

  if (smallSuitcase > limits.maxSmall) {
    const size =
      vehicleClass === '6-seater'
        ? SMALL_SUITCASE_SIZE_6SEATER_CM
        : SMALL_SUITCASE_SIZE_4SEATER_CM;
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      `${vehicleClass} allows maximum ${limits.maxSmall} small suitcase(s) (${size.length}×${size.width}×${size.height} cm).`,
    );
  }

  return {
    largeSuitcase,
    smallSuitcase,
    luggageNote,
    luggageCounts: 0,
    vehicleClass,
    sizeGuide: getLuggageSizeGuide(vehicleClass),
  };
};

/** Normalize stored passenger luggage for API / driver payloads (always charge-free). */
export const toLuggageFyiView = (passengerOrPartial?: any) => ({
  luggageCounts: 0,
  largeSuitcase: Math.max(0, Math.floor(Number(passengerOrPartial?.largeSuitcase) || 0)),
  smallSuitcase: Math.max(0, Math.floor(Number(passengerOrPartial?.smallSuitcase) || 0)),
  luggageNote: (passengerOrPartial?.luggageNote ?? '').toString(),
  note: passengerOrPartial?.note ?? undefined,
  chargeApplies: false as const,
});
