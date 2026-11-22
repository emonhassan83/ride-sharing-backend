/**
 * Unit tests: luggage & vehicle-class rules (pure functions, no mocks).
 *
 * Capacity rules: 4-seater = max 4 passengers, 2 large + 2 small suitcases.
 * 6-seater = max 6 passengers, 2 large + 4 small suitcases. Party of 5-6 needs a 6-seater.
 */
import { describe, expect, it } from 'vitest';
import {
  LARGE_SUITCASE_SIZE_CM,
  LUGGAGE_LIMITS,
  SMALL_SUITCASE_SIZE_4SEATER_CM,
  SMALL_SUITCASE_SIZE_6SEATER_CM,
  assertVehicleTypeCapacity,
  getLuggageSizeGuide,
  isVehicleType,
  normalizeAndAssertLuggage,
  resolveLuggageVehicleClass,
  resolvePrivateVehicleClass,
  toLuggageFyiView,
  vehicleFitsParty,
} from '@src/app/utils/luggage.utils';

/** Runs fn and returns the thrown error (fails the test if nothing is thrown). */
const thrownBy = (fn: () => unknown): { code: number; message: string } => {
  try {
    fn();
  } catch (err) {
    return err as { code: number; message: string };
  }
  throw new Error('expected function to throw');
};

describe('isVehicleType', () => {
  it('accepts the two vehicle classes', () => {
    expect(isVehicleType('4-seater')).toBe(true);
    expect(isVehicleType('6-seater')).toBe(true);
  });

  it.each([['5-seater'], [''], [null], [undefined], [4], ['4-SEATER']])(
    'rejects invalid value %p',
    (value) => {
      expect(isVehicleType(value)).toBe(false);
    },
  );
});

describe('resolveLuggageVehicleClass (split / seat-only)', () => {
  it.each([
    [0, '4-seater'],
    [1, '4-seater'],
    [4, '4-seater'],
    [5, '6-seater'],
    [6, '6-seater'],
  ])('%p seats -> %s', (seats, expected) => {
    expect(resolveLuggageVehicleClass(seats)).toBe(expected);
  });

  it('treats NaN as 4-seater and numeric strings by value', () => {
    expect(resolveLuggageVehicleClass(NaN)).toBe('4-seater');
    expect(resolveLuggageVehicleClass('5' as unknown as number)).toBe('6-seater');
  });
});

describe('vehicleFitsParty', () => {
  it('returns true when the vehicle seat count is unknown (null, undefined, 0)', () => {
    expect(vehicleFitsParty(null, 6)).toBe(true);
    expect(vehicleFitsParty(undefined, 6)).toBe(true);
    expect(vehicleFitsParty(0, 6)).toBe(true);
  });

  it('rejects a vehicle with fewer seats than requested', () => {
    expect(vehicleFitsParty(4, 5)).toBe(false);
  });

  it('accepts a 4-seat vehicle for a party of exactly 4', () => {
    expect(vehicleFitsParty(4, 4)).toBe(true);
  });

  it('rejects a 5-seat vehicle for a party of 5 (5-6 need a 6-seater)', () => {
    expect(vehicleFitsParty(5, 5)).toBe(false);
  });

  it('accepts a 6-seat vehicle for a party of 5 and of 6', () => {
    expect(vehicleFitsParty(6, 5)).toBe(true);
    expect(vehicleFitsParty(6, 6)).toBe(true);
  });

  it('accepts a 5-seat vehicle for a party of 4', () => {
    expect(vehicleFitsParty(5, 4)).toBe(true);
  });
});

describe('assertVehicleTypeCapacity', () => {
  it('returns the vehicle type when everything is within limits (4-seater at exact limits)', () => {
    expect(
      assertVehicleTypeCapacity({
        vehicleType: '4-seater',
        requestedSeats: 4,
        largeSuitcase: 2,
        smallSuitcase: 2,
      }),
    ).toBe('4-seater');
  });

  it('allows 6-seater at exact limits (6 seats, 2 large, 4 small)', () => {
    expect(
      assertVehicleTypeCapacity({
        vehicleType: '6-seater',
        requestedSeats: 6,
        largeSuitcase: 2,
        smallSuitcase: 4,
      }),
    ).toBe('6-seater');
  });

  it('rejects 5 passengers in a 4-seater with the exact message', () => {
    const err = thrownBy(() =>
      assertVehicleTypeCapacity({
        vehicleType: '4-seater',
        requestedSeats: 5,
        largeSuitcase: 0,
        smallSuitcase: 0,
      }),
    );
    expect(err.code).toBe(400);
    expect(err.message).toBe('4-seater allows maximum 4 passengers.');
  });

  it('rejects 3 large suitcases in a 4-seater (N+1 boundary)', () => {
    const err = thrownBy(() =>
      assertVehicleTypeCapacity({
        vehicleType: '4-seater',
        requestedSeats: 1,
        largeSuitcase: 3,
        smallSuitcase: 0,
      }),
    );
    expect(err.message).toBe(
      `4-seater allows maximum 2 large suitcases (${LARGE_SUITCASE_SIZE_CM.length}×${LARGE_SUITCASE_SIZE_CM.width}×${LARGE_SUITCASE_SIZE_CM.height} cm).`,
    );
  });

  it('rejects 3 small suitcases in a 4-seater with the 4-seater small size', () => {
    const err = thrownBy(() =>
      assertVehicleTypeCapacity({
        vehicleType: '4-seater',
        requestedSeats: 1,
        largeSuitcase: 0,
        smallSuitcase: 3,
      }),
    );
    expect(err.message).toBe('4-seater allows maximum 2 small suitcases (60×40×25 cm).');
  });

  it('rejects 5 small suitcases in a 6-seater with the 6-seater small size', () => {
    const err = thrownBy(() =>
      assertVehicleTypeCapacity({
        vehicleType: '6-seater',
        requestedSeats: 1,
        largeSuitcase: 0,
        smallSuitcase: 5,
      }),
    );
    expect(err.message).toBe(
      `6-seater allows maximum 4 small suitcases (${SMALL_SUITCASE_SIZE_6SEATER_CM.length}×${SMALL_SUITCASE_SIZE_6SEATER_CM.width}×${SMALL_SUITCASE_SIZE_6SEATER_CM.height} cm).`,
    );
  });

  it('floors fractional counts and clamps negatives/NaN to 0 before checking', () => {
    expect(
      assertVehicleTypeCapacity({
        vehicleType: '4-seater',
        requestedSeats: 4.9,
        largeSuitcase: 2.99,
        smallSuitcase: -3,
      }),
    ).toBe('4-seater');
    expect(
      assertVehicleTypeCapacity({
        vehicleType: '4-seater',
        requestedSeats: NaN,
        largeSuitcase: NaN,
        smallSuitcase: undefined as unknown as number,
      }),
    ).toBe('4-seater');
  });
});

describe('resolvePrivateVehicleClass', () => {
  it('rejects more than 6 passengers', () => {
    const err = thrownBy(() =>
      resolvePrivateVehicleClass({ requestedSeats: 7, largeSuitcase: 0, smallSuitcase: 0 }),
    );
    expect(err.code).toBe(400);
    expect(err.message).toBe('Maximum 6 passengers. 1–4 can use a 4-seater, 5–6 need a 6-seater.');
  });

  it('accepts exactly 6 passengers as a 6-seater', () => {
    expect(
      resolvePrivateVehicleClass({ requestedSeats: 6, largeSuitcase: 0, smallSuitcase: 0 }),
    ).toBe('6-seater');
  });

  it('keeps a 4-seater for 4 passengers with 2 large and 2 small (4-seater limits)', () => {
    expect(
      resolvePrivateVehicleClass({ requestedSeats: 4, largeSuitcase: 2, smallSuitcase: 2 }),
    ).toBe('4-seater');
  });

  it('upgrades to a 6-seater for 3 small suitcases (N+1 of 4-seater small limit)', () => {
    expect(
      resolvePrivateVehicleClass({ requestedSeats: 1, largeSuitcase: 0, smallSuitcase: 3 }),
    ).toBe('6-seater');
  });

  it('rejects 3 large suitcases even for a 6-seater (6-seater large max is 2)', () => {
    const err = thrownBy(() =>
      resolvePrivateVehicleClass({ requestedSeats: 1, largeSuitcase: 3, smallSuitcase: 0 }),
    );
    expect(err.message).toBe(
      `Maximum 2 large suitcases (${LARGE_SUITCASE_SIZE_CM.length}×${LARGE_SUITCASE_SIZE_CM.width}×${LARGE_SUITCASE_SIZE_CM.height} cm).`,
    );
  });

  it('keeps a 4-seater at exactly 2 large suitcases (large limit is inclusive)', () => {
    expect(
      resolvePrivateVehicleClass({ requestedSeats: 1, largeSuitcase: 2, smallSuitcase: 0 }),
    ).toBe('4-seater');
  });

  it('rejects 5 small suitcases (above the 6-seater cap of 4)', () => {
    const err = thrownBy(() =>
      resolvePrivateVehicleClass({ requestedSeats: 1, largeSuitcase: 0, smallSuitcase: 5 }),
    );
    expect(err.message).toBe(
      `6-seater allows maximum 4 small suitcases (${SMALL_SUITCASE_SIZE_6SEATER_CM.length}×${SMALL_SUITCASE_SIZE_6SEATER_CM.width}×${SMALL_SUITCASE_SIZE_6SEATER_CM.height} cm).`,
    );
  });

  it('upgrades a 5-seat party to a 6-seater even with no luggage', () => {
    expect(
      resolvePrivateVehicleClass({ requestedSeats: 5, largeSuitcase: 0, smallSuitcase: 0 }),
    ).toBe('6-seater');
  });

  it('treats 0 or negative seats as 1 passenger (4-seater)', () => {
    expect(
      resolvePrivateVehicleClass({ requestedSeats: 0, largeSuitcase: 0, smallSuitcase: 0 }),
    ).toBe('4-seater');
    expect(
      resolvePrivateVehicleClass({ requestedSeats: -2, largeSuitcase: 0, smallSuitcase: 0 }),
    ).toBe('4-seater');
  });
});

describe('normalizeAndAssertLuggage', () => {
  describe('private rides', () => {
    it('returns the normalized luggage for a valid 4-seater booking', () => {
      const result = normalizeAndAssertLuggage({
        largeSuitcase: 1,
        smallSuitcase: 2,
        luggageNote: '  fragile  ',
        requestedSeats: 3,
        rideType: 'private',
        vehicleType: '4-seater',
      });
      expect(result.vehicleClass).toBe('4-seater');
      expect(result.largeSuitcase).toBe(1);
      expect(result.smallSuitcase).toBe(2);
      expect(result.luggageNote).toBe('fragile');
      expect(result.luggageCounts).toBe(3);
      expect(result.sizeGuide).toEqual(getLuggageSizeGuide('4-seater'));
    });

    it('throws when vehicleType is missing or invalid', () => {
      const missing = thrownBy(() =>
        normalizeAndAssertLuggage({ requestedSeats: 2, rideType: 'private' }),
      );
      expect(missing.code).toBe(400);
      expect(missing.message).toBe(
        'vehicleType is required for a private ride (4-seater or 6-seater).',
      );
      expect(() =>
        normalizeAndAssertLuggage({ requestedSeats: 2, rideType: 'private', vehicleType: 'van' }),
      ).toThrow('vehicleType is required');
    });

    it('rejects 5 passengers booked as a 4-seater', () => {
      const err = thrownBy(() =>
        normalizeAndAssertLuggage({
          requestedSeats: 5,
          rideType: 'private',
          vehicleType: '4-seater',
        }),
      );
      expect(err.message).toBe('4-seater allows maximum 4 passengers.');
    });

    it('rejects 3 large suitcases in a 4-seater for a private ride', () => {
      const err = thrownBy(() =>
        normalizeAndAssertLuggage({
          largeSuitcase: 3,
          requestedSeats: 1,
          rideType: 'private',
          vehicleType: '4-seater',
        }),
      );
      expect(err.message).toBe(
        `4-seater allows maximum 2 large suitcases (${LARGE_SUITCASE_SIZE_CM.length}×${LARGE_SUITCASE_SIZE_CM.width}×${LARGE_SUITCASE_SIZE_CM.height} cm).`,
      );
    });

    it('rejects 3 small suitcases in a 4-seater with the 4-seater small size', () => {
      const err = thrownBy(() =>
        normalizeAndAssertLuggage({
          smallSuitcase: 3,
          requestedSeats: 1,
          rideType: 'private',
          vehicleType: '4-seater',
        }),
      );
      expect(err.message).toBe(
        `4-seater allows maximum 2 small suitcases (${SMALL_SUITCASE_SIZE_4SEATER_CM.length}×${SMALL_SUITCASE_SIZE_4SEATER_CM.width}×${SMALL_SUITCASE_SIZE_4SEATER_CM.height} cm).`,
      );
    });

    it('accepts 4 small suitcases in a 6-seater (exact limit) and counts them', () => {
      const result = normalizeAndAssertLuggage({
        smallSuitcase: 4,
        largeSuitcase: 2,
        requestedSeats: 6,
        rideType: 'private',
        vehicleType: '6-seater',
      });
      expect(result.vehicleClass).toBe('6-seater');
      expect(result.luggageCounts).toBe(6);
      expect(result.sizeGuide.smallSuitcaseCm).toEqual(SMALL_SUITCASE_SIZE_6SEATER_CM);
    });

    it('uses the explicit luggageCounts when it is larger than the suitcase sum', () => {
      const result = normalizeAndAssertLuggage({
        largeSuitcase: 1,
        smallSuitcase: 1,
        luggageCounts: 5,
        requestedSeats: 2,
        rideType: 'private',
        vehicleType: '4-seater',
      });
      expect(result.luggageCounts).toBe(5);
    });

    it('uses the suitcase sum when explicit luggageCounts is smaller', () => {
      const result = normalizeAndAssertLuggage({
        largeSuitcase: 2,
        smallSuitcase: 2,
        luggageCounts: 1,
        requestedSeats: 2,
        rideType: 'private',
        vehicleType: '4-seater',
      });
      expect(result.luggageCounts).toBe(4);
    });
  });

  describe('split rides (no vehicleType supplied)', () => {
    it('derives the vehicle class from seats only', () => {
      expect(
        normalizeAndAssertLuggage({ requestedSeats: 4, rideType: 'split' }).vehicleClass,
      ).toBe('4-seater');
      expect(
        normalizeAndAssertLuggage({ requestedSeats: 5, rideType: 'split' }).vehicleClass,
      ).toBe('6-seater');
    });

    it('rejects more than 6 passengers', () => {
      const err = thrownBy(() =>
        normalizeAndAssertLuggage({ requestedSeats: 7, rideType: 'split' }),
      );
      expect(err.message).toBe('Maximum 6 passengers. 1–4 use a 4-seater, 5–6 use a 6-seater.');
    });

    it('treats a missing requestedSeats (NaN) as 1 passenger', () => {
      const result = normalizeAndAssertLuggage({
        requestedSeats: undefined as unknown as number,
        rideType: 'split',
      });
      expect(result.vehicleClass).toBe('4-seater');
      expect(result.luggageNote).toBe('');
    });

    it('CHARACTERIZATION: split rides do not enforce suitcase limits (5 large suitcases pass)', () => {
      // Surprising but possibly intentional: only private rides run assertVehicleTypeCapacity.
      const result = normalizeAndAssertLuggage({
        largeSuitcase: 5,
        smallSuitcase: 0,
        requestedSeats: 1,
        rideType: 'split',
      });
      expect(result.largeSuitcase).toBe(5);
      expect(result.vehicleClass).toBe('4-seater');
    });
  });

  it('defaults a non-private, non-split ride type to the split path (seats-only class)', () => {
    const result = normalizeAndAssertLuggage({ requestedSeats: 5 });
    expect(result.vehicleClass).toBe('6-seater');
  });

  it('floors fractional suitcase counts and clamps negatives to 0', () => {
    const result = normalizeAndAssertLuggage({
      largeSuitcase: 1.8,
      smallSuitcase: -2,
      requestedSeats: 2,
      rideType: 'private',
      vehicleType: '4-seater',
    });
    expect(result.largeSuitcase).toBe(1);
    expect(result.smallSuitcase).toBe(0);
    expect(result.luggageCounts).toBe(1);
  });
});

describe('toLuggageFyiView', () => {
  it('returns zeros, empty note and chargeApplies false for missing input', () => {
    expect(toLuggageFyiView()).toEqual({
      luggageCounts: 0,
      largeSuitcase: 0,
      smallSuitcase: 0,
      luggageNote: '',
      note: undefined,
      chargeApplies: false,
    });
  });

  it('coerces numeric strings, floors fractions and clamps negatives', () => {
    const view = toLuggageFyiView({ largeSuitcase: '2', smallSuitcase: -1.5, luggageCounts: 1 });
    expect(view.largeSuitcase).toBe(2);
    expect(view.smallSuitcase).toBe(0);
    expect(view.luggageCounts).toBe(2);
  });

  it('passes the stored luggageNote and note through, always chargeApplies: false', () => {
    const view = toLuggageFyiView({
      largeSuitcase: 1,
      smallSuitcase: 1,
      luggageNote: 'guitar',
      note: 'call on arrival',
    });
    expect(view.luggageNote).toBe('guitar');
    expect(view.note).toBe('call on arrival');
    expect(view.chargeApplies).toBe(false);
    expect(view.luggageCounts).toBe(2);
  });

  it('keeps the explicit luggageCounts when it exceeds the suitcase sum', () => {
    expect(toLuggageFyiView({ largeSuitcase: 1, smallSuitcase: 0, luggageCounts: 4 }).luggageCounts).toBe(4);
  });
});

describe('getLuggageSizeGuide / LUGGAGE_LIMITS', () => {
  it('returns the 6-seater small size and limits for a 6-seater', () => {
    const guide = getLuggageSizeGuide('6-seater');
    expect(guide.smallSuitcaseCm).toEqual({ length: 60, width: 40, height: 26 });
    expect(guide.limits).toEqual(LUGGAGE_LIMITS['6-seater']);
    expect(guide.chargeApplies).toBe(false);
  });

  it('returns the 4-seater small size for a 4-seater', () => {
    expect(getLuggageSizeGuide('4-seater').smallSuitcaseCm).toEqual({ length: 60, width: 40, height: 25 });
  });
});
