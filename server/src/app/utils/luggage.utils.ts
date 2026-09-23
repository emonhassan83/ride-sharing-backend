import { StatusCodes } from 'http-status-codes';
import ApiError from '../errors/ApiError';

/** FYI-only luggage sizes (no fare charge). */
export const LARGE_SUITCASE_SIZE_CM = { length: 75, width: 50, height: 35 } as const;
export const SMALL_SUITCASE_SIZE_4SEATER_CM = { length: 60, width: 40, height: 25 } as const;
export const SMALL_SUITCASE_SIZE_6SEATER_CM = { length: 60, width: 40, height: 26 } as const;

export const VEHICLE_TYPES = ['4-seater', '6-seater'] as const;
export type LuggageVehicleClass = (typeof VEHICLE_TYPES)[number];

export const isVehicleType = (value: unknown): value is LuggageVehicleClass =>
  value === '4-seater' || value === '6-seater';

/** Luggage and passengers must fit the vehicleType the rider selected. */
export const assertVehicleTypeCapacity = (input: {
  vehicleType: LuggageVehicleClass;
  requestedSeats: number;
  largeSuitcase: number;
  smallSuitcase: number;
}): LuggageVehicleClass => {
  const { vehicleType } = input;
  const requestedSeats = Math.max(1, Math.floor(Number(input.requestedSeats) || 1));
  const largeSuitcase = Math.max(0, Math.floor(Number(input.largeSuitcase) || 0));
  const smallSuitcase = Math.max(0, Math.floor(Number(input.smallSuitcase) || 0));
  const maxPassengers = vehicleType === '6-seater' ? 6 : 4;
  const limits = LUGGAGE_LIMITS[vehicleType];
  const smallSize =
    vehicleType === '6-seater'
      ? SMALL_SUITCASE_SIZE_6SEATER_CM
      : SMALL_SUITCASE_SIZE_4SEATER_CM;

  if (requestedSeats > maxPassengers) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      `${vehicleType} allows maximum ${maxPassengers} passengers.`,
    );
  }
  if (largeSuitcase > limits.maxLarge) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      `${vehicleType} allows maximum ${limits.maxLarge} large suitcases (${LARGE_SUITCASE_SIZE_CM.length}×${LARGE_SUITCASE_SIZE_CM.width}×${LARGE_SUITCASE_SIZE_CM.height} cm).`,
    );
  }
  if (smallSuitcase > limits.maxSmall) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      `${vehicleType} allows maximum ${limits.maxSmall} small suitcases (${smallSize.length}×${smallSize.width}×${smallSize.height} cm).`,
    );
  }
  return vehicleType;
};

export const LUGGAGE_LIMITS = {
  '4-seater': { maxLarge: 2, maxSmall: 2 },
  '6-seater': { maxLarge: 2, maxSmall: 4 },
} as const;

/** Split / seat-only: ≤4 → 4-seater, ≥5 → 6-seater. */
export const resolveLuggageVehicleClass = (
  requestedSeats: number,
): LuggageVehicleClass => (Number(requestedSeats) >= 5 ? '6-seater' : '4-seater');

/**
 * Private ride: boot capacity picks the vehicle.
 * 4-seater fits ≤2 large and ≤2 small. More small bags (3–4) need a 6-seater.
 * 5–6 passengers also need a 6-seater.
 */
export const resolvePrivateVehicleClass = (input: {
  requestedSeats: number;
  largeSuitcase: number;
  smallSuitcase: number;
}): LuggageVehicleClass => {
  const requestedSeats = Math.max(1, Math.floor(Number(input.requestedSeats) || 1));
  const largeSuitcase = Math.max(0, Math.floor(Number(input.largeSuitcase) || 0));
  const smallSuitcase = Math.max(0, Math.floor(Number(input.smallSuitcase) || 0));

  if (requestedSeats > 6) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      'Maximum 6 passengers. 1–4 can use a 4-seater, 5–6 need a 6-seater.',
    );
  }
  if (largeSuitcase > LUGGAGE_LIMITS['6-seater'].maxLarge) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      `Maximum ${LUGGAGE_LIMITS['6-seater'].maxLarge} large suitcases (${LARGE_SUITCASE_SIZE_CM.length}×${LARGE_SUITCASE_SIZE_CM.width}×${LARGE_SUITCASE_SIZE_CM.height} cm).`,
    );
  }
  if (smallSuitcase > LUGGAGE_LIMITS['6-seater'].maxSmall) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      `6-seater allows maximum ${LUGGAGE_LIMITS['6-seater'].maxSmall} small suitcases (${SMALL_SUITCASE_SIZE_6SEATER_CM.length}×${SMALL_SUITCASE_SIZE_6SEATER_CM.width}×${SMALL_SUITCASE_SIZE_6SEATER_CM.height} cm).`,
    );
  }
  if (
    requestedSeats >= 5 ||
    smallSuitcase > LUGGAGE_LIMITS['4-seater'].maxSmall ||
    largeSuitcase > LUGGAGE_LIMITS['4-seater'].maxLarge
  ) {
    return '6-seater';
  }
  return '4-seater';
};

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
  /** Auto: largeSuitcase + smallSuitcase. Fare still ignores this count. */
  luggageCounts: number;
  vehicleClass: LuggageVehicleClass;
  sizeGuide: ReturnType<typeof getLuggageSizeGuide>;
};

/** 1–4 passengers → 4-seater, 5–6 → 6-seater. */
export const vehicleFitsParty = (
  vehicleSeats: number | null | undefined,
  requestedSeats: number,
): boolean => {
  const seats = Number(vehicleSeats) || 0;
  if (seats <= 0) return true;
  if (seats < requestedSeats) return false;
  if (resolveLuggageVehicleClass(requestedSeats) === '6-seater' && seats < 6) {
    return false;
  }
  return true;
};

export const normalizeAndAssertLuggage = (input: {
  largeSuitcase?: number;
  smallSuitcase?: number;
  luggageNote?: string;
  requestedSeats: number;
  rideType?: 'private' | 'split';
  vehicleType?: string;
}): NormalizedLuggage => {
  const requestedSeats = Math.max(1, Math.floor(Number(input.requestedSeats) || 1));
  if (requestedSeats > 6) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      'Maximum 6 passengers. 1–4 use a 4-seater, 5–6 use a 6-seater.',
    );
  }

  const largeSuitcase = Math.max(0, Math.floor(Number(input.largeSuitcase) || 0));
  const smallSuitcase = Math.max(0, Math.floor(Number(input.smallSuitcase) || 0));
  const luggageNote = (input.luggageNote ?? '').toString().trim();
  let vehicleClass: LuggageVehicleClass;
  if (input.rideType === 'private') {
    if (!isVehicleType(input.vehicleType)) {
      throw new ApiError(
        StatusCodes.BAD_REQUEST,
        'vehicleType is required for a private ride (4-seater or 6-seater).',
      );
    }
    vehicleClass = assertVehicleTypeCapacity({
      vehicleType: input.vehicleType,
      requestedSeats,
      largeSuitcase,
      smallSuitcase,
    });
  } else {
    vehicleClass = resolveLuggageVehicleClass(requestedSeats);
  }
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
    luggageCounts: largeSuitcase + smallSuitcase,
    vehicleClass,
    sizeGuide: getLuggageSizeGuide(vehicleClass),
  };
};

/** Normalize stored passenger luggage for API / driver payloads (always charge-free). */
export const toLuggageFyiView = (passengerOrPartial?: any) => {
  const largeSuitcase = Math.max(
    0,
    Math.floor(Number(passengerOrPartial?.largeSuitcase) || 0),
  );
  const smallSuitcase = Math.max(
    0,
    Math.floor(Number(passengerOrPartial?.smallSuitcase) || 0),
  );
  return {
    luggageCounts: largeSuitcase + smallSuitcase,
    largeSuitcase,
    smallSuitcase,
    luggageNote: (passengerOrPartial?.luggageNote ?? '').toString(),
    note: passengerOrPartial?.note ?? undefined,
    chargeApplies: false as const,
  };
};
