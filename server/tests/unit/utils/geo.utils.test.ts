/**
 * Unit tests: geo.utils (driver location in Redis GEO, distance helpers, driver availability,
 * nearby-driver enrichment, corridor-to-route checks).
 *
 * - Redis: the global in-memory fake (`fakeRedis`) holds the real GEO / hash / string state.
 * - DB models (Ride, User, Vehicle) and the Google Maps wrapper are mocked (no DB, no network).
 *
 * Distance reference values (R = 6371 km unless noted):
 *   1 deg latitude            = 111 194.93 m
 *   0.1 deg longitude @ equator = 11.11949 km
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRedis } from '@tests/helpers/fakeRedis';
import { freezeTime } from '@tests/helpers/time';
import { createModelMock } from '@tests/helpers/modelMock';
import { mockQuery, mockQueryError, oid } from '@tests/helpers/mongoose';
import { Ride } from '@src/app/modules/ride/ride.model';
import { User } from '@src/app/modules/user/user.model';
import { Vehicle } from '@src/app/modules/vehicle/vehicle.model';
import { getRealDistanceAndETA } from '@src/app/utils/maps.utils';
import {
  calculateDistanceInMeters,
  fetchDriversWithinRadius,
  findNearbyDrivers,
  haversineMeters,
  hasDriverRideAtDateTime,
  isDriverNearPickup,
  isPointNearRoute,
  removeDriverLocation,
  saveDriverLocation,
} from '@src/app/utils/geo.utils';

vi.mock('@src/app/modules/ride/ride.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Ride: createModelMock() };
});
vi.mock('@src/app/modules/user/user.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { User: createModelMock() };
});
vi.mock('@src/app/modules/vehicle/vehicle.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Vehicle: createModelMock() };
});
vi.mock('@src/app/utils/maps.utils', () => ({ getRealDistanceAndETA: vi.fn() }));

const GEO_KEY = 'drivers:location';

/** Ride document as returned by Ride.find(...).lean() in hasDriverRideAtDateTime. */
const rideDoc = (overrides: Record<string, unknown> = {}) => ({
  _id: oid(),
  type: 'private',
  departureTime: '10:00',
  totalSeats: 4,
  bookedSeats: 0,
  ...overrides,
});

describe('calculateDistanceInMeters (haversine, R = 6371 km)', () => {
  it('returns 0 for identical points', () => {
    expect(calculateDistanceInMeters(35.1, 33.4, 35.1, 33.4)).toBe(0);
  });

  it('one degree of latitude is about 111 194.93 m', () => {
    expect(calculateDistanceInMeters(0, 0, 1, 0)).toBeCloseTo(111194.9266, 3);
  });

  it('one degree of longitude on the equator equals one degree of latitude', () => {
    expect(calculateDistanceInMeters(0, 0, 0, 1)).toBeCloseTo(111194.9266, 3);
  });

  it('one degree of longitude at 60 deg N is halved (cos 60 = 0.5)', () => {
    expect(calculateDistanceInMeters(60, 0, 60, 1)).toBeCloseTo(55596.93, 0);
  });

  it('crosses the antimeridian correctly (179 -> -179 is 2 degrees, not 358)', () => {
    expect(calculateDistanceInMeters(0, 179, 0, -179)).toBeCloseTo(222389.853, 2);
  });

  it('pole to pole is half the circumference (pi * R)', () => {
    expect(calculateDistanceInMeters(90, 0, -90, 0)).toBeCloseTo(6371000 * Math.PI, 2);
  });

  it('is symmetric', () => {
    expect(calculateDistanceInMeters(35.1, 33.4, 34.7, 33.0)).toBe(
      calculateDistanceInMeters(34.7, 33.0, 35.1, 33.4),
    );
  });

  it('returns NaN for NaN input (no silent coercion)', () => {
    expect(calculateDistanceInMeters(NaN, 0, 0, 0)).toBeNaN();
  });
});

describe('haversineMeters (R = 6 378 100 m)', () => {
  it('returns 0 for identical points', () => {
    expect(haversineMeters(10, 10, 10, 10)).toBe(0);
  });

  it('one degree of latitude is about 111 319.49 m with this radius', () => {
    expect(haversineMeters(0, 0, 1, 0)).toBeCloseTo(6378100 * (Math.PI / 180), 3);
  });

  it('CHARACTERIZATION: uses a different Earth radius than calculateDistanceInMeters (about 0.09% larger)', () => {
    const a = haversineMeters(0, 0, 1, 0);
    const b = calculateDistanceInMeters(0, 0, 1, 0);
    expect(a).toBeGreaterThan(b);
    expect(a / b).toBeCloseTo(6378100 / 6371000, 6);
  });
});

describe('saveDriverLocation / removeDriverLocation', () => {
  beforeEach(() => {
    freezeTime('2026-05-01T10:00:00Z');
    vi.mocked(User.findByIdAndUpdate).mockReturnValue(mockQuery(null) as any);
  });

  it('adds the driver to the drivers:location GEO set at the given lat/lng', async () => {
    await saveDriverLocation('driver-1', 35.1856, 33.3823);

    const near = await fakeRedis.georadius(GEO_KEY, 33.3823, 35.1856, 1, 'km');
    expect(near).toContain('driver-1');
  });

  it('stores last position and update time in the driver details hash', async () => {
    await saveDriverLocation('driver-1', 35.1856, 33.3823);

    const details = await fakeRedis.hgetall('driver:driver-1:details');
    expect(details).toEqual({
      lastLat: '35.1856',
      lastLng: '33.3823',
      lastUpdate: String(Date.parse('2026-05-01T10:00:00Z')),
    });
  });

  it('writes a current-location JSON record with a 300 second TTL', async () => {
    await saveDriverLocation('driver-1', 35.1856, 33.3823);

    expect(JSON.parse(fakeRedis.peek('driver:driver-1:current')!)).toEqual({
      lat: 35.1856,
      lng: 33.3823,
      timestamp: Date.parse('2026-05-01T10:00:00Z'),
    });
    expect(await fakeRedis.ttl('driver:driver-1:current')).toBe(300);
  });

  it('persists the location to the User document in GeoJSON [lng, lat] order', async () => {
    await saveDriverLocation('driver-1', 35.1856, 33.3823);

    expect(User.findByIdAndUpdate).toHaveBeenCalledWith(
      'driver-1',
      { location: { type: 'Point', coordinates: [33.3823, 35.1856] } },
      { returnDocument: 'after' },
    );
  });

  it('does not reject when the DB write fails (fire-and-forget)', async () => {
    vi.mocked(User.findByIdAndUpdate).mockReturnValue(mockQueryError(new Error('db down')) as any);

    await expect(saveDriverLocation('driver-1', 1, 2)).resolves.toBeUndefined();
    expect(await fakeRedis.georadius(GEO_KEY, 2, 1, 1, 'km')).toContain('driver-1');
  });

  it('a later save overwrites the previous position for the same driver', async () => {
    await saveDriverLocation('driver-1', 0, 0);
    await saveDriverLocation('driver-1', 10, 10);

    expect(await fakeRedis.georadius(GEO_KEY, 0, 0, 1, 'km')).not.toContain('driver-1');
    expect(await fakeRedis.georadius(GEO_KEY, 10, 10, 1, 'km')).toContain('driver-1');
  });

  it('removeDriverLocation takes the driver out of the GEO set', async () => {
    await saveDriverLocation('driver-1', 35, 33);
    await removeDriverLocation('driver-1');

    expect(await fakeRedis.georadius(GEO_KEY, 33, 35, 1, 'km')).not.toContain('driver-1');
  });

  it('removeDriverLocation leaves other drivers in place', async () => {
    await saveDriverLocation('driver-1', 35, 33);
    await saveDriverLocation('driver-2', 35, 33);
    await removeDriverLocation('driver-1');

    expect(await fakeRedis.georadius(GEO_KEY, 33, 35, 1, 'km')).toEqual(['driver-2']);
  });

  it('CHARACTERIZATION: removeDriverLocation keeps the short-lived driver:<id>:current record', async () => {
    await saveDriverLocation('driver-1', 35, 33);
    await removeDriverLocation('driver-1');

    expect(fakeRedis.peek('driver:driver-1:current')).not.toBeNull();
  });
});

describe('isDriverNearPickup', () => {
  const pickup = { lat: 0, lng: 0 };

  it('returns null when the driver has no current location record', async () => {
    expect(await isDriverNearPickup('driver-1', pickup.lat, pickup.lng)).toBeNull();
  });

  it('is near with distance 0 when the driver is exactly at the pickup', async () => {
    await fakeRedis.set('driver:driver-1:current', JSON.stringify({ lat: 0, lng: 0, timestamp: 1 }));

    expect(await isDriverNearPickup('driver-1', 0, 0)).toEqual({ isNear: true, distanceMeters: 0 });
  });

  it('is near when the driver is 99 m away with the default 100 m threshold', async () => {
    const lat = (99 / 6371000) * (180 / Math.PI);
    await fakeRedis.set('driver:driver-1:current', JSON.stringify({ lat, lng: 0, timestamp: 1 }));

    const result = await isDriverNearPickup('driver-1', 0, 0);

    expect(result?.isNear).toBe(true);
    expect(result?.distanceMeters).toBe(99);
  });

  it('is NOT near when the driver is 101 m away with the default 100 m threshold', async () => {
    const lat = (101 / 6371000) * (180 / Math.PI);
    await fakeRedis.set('driver:driver-1:current', JSON.stringify({ lat, lng: 0, timestamp: 1 }));

    const result = await isDriverNearPickup('driver-1', 0, 0);

    expect(result?.isNear).toBe(false);
    expect(result?.distanceMeters).toBe(101);
  });

  it('threshold is inclusive: a driver exactly at the threshold distance is near', async () => {
    const exact = calculateDistanceInMeters(0, 0, 0.001, 0);
    await fakeRedis.set('driver:driver-1:current', JSON.stringify({ lat: 0.001, lng: 0, timestamp: 1 }));

    expect((await isDriverNearPickup('driver-1', 0, 0, exact))?.isNear).toBe(true);
    expect((await isDriverNearPickup('driver-1', 0, 0, exact - 0.01))?.isNear).toBe(false);
  });

  it('CHARACTERIZATION: a corrupted current-location record throws a SyntaxError', async () => {
    await fakeRedis.set('driver:driver-1:current', '{oops');

    await expect(isDriverNearPickup('driver-1', 0, 0)).rejects.toThrow(SyntaxError);
  });
});

describe('findNearbyDrivers', () => {
  it('returns an empty array when no driver is in the GEO set', async () => {
    expect(await findNearbyDrivers(35.1856, 33.3823)).toEqual([]);
  });

  it('returns drivers inside the radius with rounded metre distances', async () => {
    // 0.01 deg of latitude ~ 1111.95 m
    await fakeRedis.geoadd(GEO_KEY, 33.3823, 35.1956, 'close');

    const result = await findNearbyDrivers(35.1856, 33.3823);

    expect(result).toHaveLength(1);
    expect(result[0].driverId).toBe('close');
    expect(result[0].distanceMeters).toBeGreaterThan(1100);
    expect(result[0].distanceMeters).toBeLessThan(1120);
    expect(Number.isInteger(result[0].distanceMeters)).toBe(true);
  });

  it('excludes drivers outside the radius (5 km default; 5.5 km is out, 4.5 km is in)', async () => {
    // 1 deg latitude = 111.195 km -> 0.0404 deg ~ 4.49 km, 0.0495 deg ~ 5.50 km
    await fakeRedis.geoadd(GEO_KEY, 0, 0.0404, 'inside', 0, 0.0495, 'outside');

    const ids = (await findNearbyDrivers(0, 0)).map((d) => d.driverId);

    expect(ids).toEqual(['inside']);
  });

  it('honours a custom radius (boundary of 1 km)', async () => {
    await fakeRedis.geoadd(GEO_KEY, 0, 0.005, 'within-1km', 0, 0.02, 'beyond-1km');

    const ids = (await findNearbyDrivers(0, 0, 1000)).map((d) => d.driverId);

    expect(ids).toEqual(['within-1km']);
  });
});

describe('hasDriverRideAtDateTime', () => {
  beforeEach(() => {
    vi.mocked(Ride.find).mockReturnValue(mockQuery([]) as any);
  });

  const setRides = (rides: unknown[]) =>
    vi.mocked(Ride.find).mockReturnValue(mockQuery(rides) as any);

  it('reports the driver free when there are no active rides on that date', async () => {
    expect(await hasDriverRideAtDateTime('d1', '2026-06-01', '10:00', 'private', 1)).toEqual({
      available: true,
      reason: 'Driver free',
    });
  });

  it('queries only rides on that date that are not rejected, cancelled or completed', async () => {
    await hasDriverRideAtDateTime('d1', '2026-06-01', '10:00', 'private', 1);

    expect(Ride.find).toHaveBeenCalledWith({
      driverId: 'd1',
      departureDate: '2026-06-01',
      status: { $nin: ['rejected', 'cancelled', 'completed'] },
    });
  });

  it('blocks a private request at the same departure time as another ride', async () => {
    setRides([rideDoc({ departureTime: '10:00' })]);

    expect(await hasDriverRideAtDateTime('d1', '2026-06-01', '10:00', 'private', 1)).toEqual({
      available: false,
      reason: 'Driver has another ride at this time',
    });
  });

  it('allows a split request at the same time when the split ride has enough seats (exact fit)', async () => {
    const ride = rideDoc({ type: 'split', totalSeats: 4, bookedSeats: 2 });
    setRides([ride]);

    expect(await hasDriverRideAtDateTime('d1', '2026-06-01', '10:00', 'split', 2)).toEqual({
      available: true,
      rideId: ride._id.toString(),
      reason: 'Join existing split ride',
    });
  });

  it('rejects a split request at the same time when one seat too many is requested', async () => {
    setRides([rideDoc({ type: 'split', totalSeats: 4, bookedSeats: 2 })]);

    expect(await hasDriverRideAtDateTime('d1', '2026-06-01', '10:00', 'split', 3)).toEqual({
      available: false,
      reason: 'Not enough seats in split ride',
    });
  });

  it('blocks a private request at the same time as a split ride', async () => {
    setRides([rideDoc({ type: 'split', totalSeats: 4, bookedSeats: 0 })]);

    expect((await hasDriverRideAtDateTime('d1', '2026-06-01', '10:00', 'private', 1)).available).toBe(false);
  });

  it('treats a split ride with no totalSeats as having no seats', async () => {
    setRides([rideDoc({ type: 'split', totalSeats: undefined, bookedSeats: 0 })]);

    expect(await hasDriverRideAtDateTime('d1', '2026-06-01', '10:00', 'split', 1)).toEqual({
      available: false,
      reason: 'Not enough seats in split ride',
    });
  });

  it('blocks a private request that starts during another private trip (10:59 is inside 10:00-11:00)', async () => {
    setRides([rideDoc({ departureTime: '10:00' })]);

    expect(await hasDriverRideAtDateTime('d1', '2026-06-01', '10:59', 'private', 1)).toEqual({
      available: false,
      reason: 'Driver is on another trip at this time',
    });
  });

  it('a private request at exactly the end of the 60-minute trip (11:00) is free (boundary)', async () => {
    setRides([rideDoc({ departureTime: '10:00' })]);

    expect((await hasDriverRideAtDateTime('d1', '2026-06-01', '11:00', 'private', 1)).available).toBe(true);
  });

  it('blocks a request that starts 1 minute before another ride and would overlap it (09:01 vs 10:00)', async () => {
    setRides([rideDoc({ departureTime: '10:00' })]);

    expect(await hasDriverRideAtDateTime('d1', '2026-06-01', '09:01', 'private', 1)).toEqual({
      available: false,
      reason: 'New ride would conflict with upcoming trip',
    });
  });

  it('a request exactly 60 minutes before another ride is free (09:00 vs 10:00 boundary)', async () => {
    setRides([rideDoc({ departureTime: '10:00' })]);

    expect((await hasDriverRideAtDateTime('d1', '2026-06-01', '09:00', 'private', 1)).available).toBe(true);
  });

  it('allows a split request en route to a split ride that has seats', async () => {
    const ride = rideDoc({ type: 'split', departureTime: '10:00', totalSeats: 4, bookedSeats: 1 });
    setRides([ride]);

    expect(await hasDriverRideAtDateTime('d1', '2026-06-01', '10:30', 'split', 3)).toEqual({
      available: true,
      rideId: ride._id.toString(),
      reason: 'Join existing split ride (en route pickup)',
    });
  });

  it('rejects a split request en route to a full split ride', async () => {
    setRides([rideDoc({ type: 'split', departureTime: '10:00', totalSeats: 4, bookedSeats: 4 })]);

    expect(await hasDriverRideAtDateTime('d1', '2026-06-01', '10:30', 'split', 1)).toEqual({
      available: false,
      reason: 'Split ride in progress, no seats',
    });
  });

  it('split request starting before a split ride with insufficient seats is rejected (reverse overlap)', async () => {
    setRides([rideDoc({ type: 'split', departureTime: '10:30', totalSeats: 2, bookedSeats: 2 })]);

    expect(await hasDriverRideAtDateTime('d1', '2026-06-01', '10:00', 'split', 1)).toEqual({
      available: false,
      reason: 'Not enough seats',
    });
  });

  it('split request starting before a split ride with seats joins it (reverse overlap)', async () => {
    const ride = rideDoc({ type: 'split', departureTime: '10:30', totalSeats: 4, bookedSeats: 0 });
    setRides([ride]);

    expect(await hasDriverRideAtDateTime('d1', '2026-06-01', '10:00', 'split', 1)).toEqual({
      available: true,
      rideId: ride._id.toString(),
      reason: 'Join existing split ride',
    });
  });

  it('a private request that starts before a private ride is blocked (reverse overlap)', async () => {
    setRides([rideDoc({ type: 'private', departureTime: '10:30' })]);

    expect((await hasDriverRideAtDateTime('d1', '2026-06-01', '10:00', 'private', 1)).available).toBe(false);
  });

  it('a private request for a driver with two rides is blocked by the second one', async () => {
    setRides([rideDoc({ departureTime: '08:00' }), rideDoc({ departureTime: '10:00' })]);

    expect((await hasDriverRideAtDateTime('d1', '2026-06-01', '10:00', 'private', 1)).available).toBe(false);
  });

  it('a private request with no conflicts against any ride is free', async () => {
    setRides([rideDoc({ departureTime: '06:00' }), rideDoc({ departureTime: '15:00' })]);

    expect((await hasDriverRideAtDateTime('d1', '2026-06-01', '10:00', 'private', 1)).available).toBe(true);
  });
});

describe('fetchDriversWithinRadius', () => {
  // Pickup at the equator/prime meridian. 0.1 deg lng = 11.12 km; 0.02 deg lng = 2.22 km.
  const PICKUP = { lat: 0, lng: 0 };
  const DEST = { lat: 0, lng: 1 };
  const ORIGIN = { lat: 0, lng: 0 };

  const seedGeo = async (id: string, lng: number, lat = 0) => {
    await fakeRedis.geoadd(GEO_KEY, lng, lat, id);
  };

  const seedDetails = async (id: string, fields: Record<string, string>) => {
    await fakeRedis.hset(`driver:${id}:details`, fields);
  };

  const run = (rideType = 'private', seats = 1, dest = DEST) =>
    fetchDriversWithinRadius(
      fakeRedis,
      PICKUP.lng,
      PICKUP.lat,
      20,
      rideType,
      seats,
      dest,
      '2026-06-01',
      '10:00',
    );

  beforeEach(() => {
    vi.mocked(Ride.find).mockReturnValue(mockQuery([]) as any);
    vi.mocked(User.find).mockReturnValue(mockQuery([]) as any);
    vi.mocked(User.findById).mockReturnValue(mockQuery(null) as any);
    vi.mocked(Vehicle.findOne).mockReturnValue(mockQuery(null) as any);
    vi.mocked(getRealDistanceAndETA).mockResolvedValue({ distanceKm: 3.456, durationMinutes: 9 });
  });

  it('returns an empty list when no driver is online in Redis or in the DB', async () => {
    expect(await run()).toEqual([]);
  });

  it('builds a driver card from the Redis details hash and uses Maps for distance and ETA', async () => {
    await seedGeo('d1', 0.02);
    await seedDetails('d1', {
      name: 'Ana',
      email: 'ana@example.test',
      phone: '+35700000001',
      rating: '4.8',
      photo: 'https://img.example.test/ana.jpg',
      vehicleModel: 'Toyota Yaris',
      vehicleNumber: 'ABC123',
      seats: '4',
      bookedSeats: '1',
      lastLat: '0.0',
      lastLng: '0.02',
    });

    const [card] = await run('private', 1);

    expect(card).toEqual({
      driverId: 'd1',
      driverName: 'Ana',
      driverEmail: 'ana@example.test',
      driverPhone: '+35700000001',
      driverRating: 4.8,
      driverPhoto: 'https://img.example.test/ana.jpg',
      isOnline: true,
      vehicle: { model: 'Toyota Yaris', number: 'ABC123', seats: 4, availableSeats: 3 },
      location: { lat: 0, lng: 0.02 },
      distance: 3.46,
      eta: 9,
    });
    expect(getRealDistanceAndETA).toHaveBeenCalledWith({ lat: 0, lng: 0.02 }, PICKUP);
  });

  it('uses the Redis current location in preference to the hash location', async () => {
    await seedGeo('d1', 0.02);
    await seedDetails('d1', { seats: '4', lastLat: '0', lastLng: '0.02' });
    await fakeRedis.set('driver:d1:current', JSON.stringify({ lat: 0.5, lng: 0.5, timestamp: 1 }));

    const [card] = await run();

    expect(card.location).toEqual({ lat: 0.5, lng: 0.5 });
    expect(getRealDistanceAndETA).toHaveBeenCalledWith({ lat: 0.5, lng: 0.5 }, PICKUP);
  });

  it('ignores a corrupted current-location record and keeps the hash location', async () => {
    await seedGeo('d1', 0.02);
    await seedDetails('d1', { seats: '4', lastLat: '0', lastLng: '0.02' });
    await fakeRedis.set('driver:d1:current', '{broken');

    const [card] = await run();

    expect(card.location).toEqual({ lat: 0, lng: 0.02 });
  });

  it('falls back to the straight-line geo distance and an ETA at 30 km/h when Maps fails', async () => {
    await seedGeo('d1', 0.1);
    await seedDetails('d1', { seats: '4' });
    vi.mocked(getRealDistanceAndETA).mockRejectedValue(new Error('maps down'));

    const [card] = await run();

    // Redis GEODIST-based distance, ~11.12 km; ETA = round(11.12 / 30 * 60) = 22 min
    expect(card.distance).toBeCloseTo(11.12, 2);
    expect(card.eta).toBe(22);
  });

  it('takes the Redis GEO distance over the DB location when both sources know the driver (Maps down)', async () => {
    await seedGeo('d1', 0.02);
    await seedDetails('d1', { seats: '4' });
    vi.mocked(User.find).mockReturnValue(
      mockQuery([
        { _id: { toString: () => 'd1' }, location: { coordinates: [0.05, 0] }, avgRating: 4 },
      ]) as any,
    );
    vi.mocked(getRealDistanceAndETA).mockRejectedValue(new Error('maps down'));

    const cards = await run();

    // Redis: 0.02 deg lng = 2.22 km (not the DB point at 0.05 deg = 5.56 km)
    expect(cards.map((c) => c.driverId)).toEqual(['d1']);
    expect(cards[0].distance).toBeCloseTo(2.22, 2);
  });

  it('builds a card for a DB-only driver from the User and default Vehicle records', async () => {
    vi.mocked(User.find).mockReturnValue(
      mockQuery([
        {
          _id: { toString: () => 'db-1' },
          name: 'Ben',
          email: 'ben@example.test',
          phone: '+35700000002',
          avgRating: 4.2,
          profileImage: 'p.jpg',
          location: { coordinates: [0.02, 0] },
        },
      ]) as any,
    );
    vi.mocked(Vehicle.findOne).mockReturnValue(
      mockQuery({ name: 'Honda Civic', number: 'XYZ789', seats: 5 }) as any,
    );

    const [card] = await run('private', 1);

    expect(card).toMatchObject({
      driverId: 'db-1',
      driverName: 'Ben',
      driverRating: 4.2,
      vehicle: { model: 'Honda Civic', number: 'XYZ789', seats: 5, availableSeats: 5 },
      location: { lat: 0, lng: 0.02 },
    });
  });

  it('skips a DB driver whose stored location is exactly 0,0 (treated as "no location")', async () => {
    vi.mocked(User.find).mockReturnValue(
      mockQuery([{ _id: { toString: () => 'zero' }, location: { coordinates: [0, 0] } }]) as any,
    );

    expect(await run()).toEqual([]);
  });

  it('CHARACTERIZATION: a driver with no rating or a rating of 0 is shown with rating 5', async () => {
    await seedGeo('d1', 0.02);
    await seedDetails('d1', { seats: '4', rating: '0' });

    const [card] = await run();

    expect(card.driverRating).toBe(5);
  });

  it('excludes a driver who has a conflicting ride at the requested time', async () => {
    await seedGeo('d1', 0.02);
    await seedDetails('d1', { seats: '4' });
    vi.mocked(Ride.find).mockReturnValue(mockQuery([rideDoc({ departureTime: '10:00' })]) as any);

    expect(await run()).toEqual([]);
  });

  it('private rides: vehicle seats must be >= requested seats (3 seats needed by 2-seat car is excluded; 2 is kept)', async () => {
    await seedGeo('small', 0.02);
    await seedDetails('small', { seats: '2' });
    await seedGeo('exact', 0.02, 0.0001);
    await seedDetails('exact', { seats: '3' });

    expect((await run('private', 3)).map((c) => c.driverId)).toEqual(['exact']);
    expect((await run('private', 2)).map((c) => c.driverId).sort()).toEqual(['exact', 'small']);
  });

  it('split rides: available seats (total - booked) must cover the request exactly (2 free, 2 requested is kept; 3 is excluded)', async () => {
    await seedGeo('d1', 0.02);
    await seedDetails('d1', { seats: '4', bookedSeats: '2' });

    expect((await run('split', 2)).map((c) => c.driverId)).toEqual(['d1']);
    expect(await run('split', 3)).toEqual([]);
  });

  it('split rides: a driver whose destination is 4.4 km away (0.04 deg lng) is kept', async () => {
    await seedGeo('d1', 0.02);
    await seedDetails('d1', { seats: '4', destination: JSON.stringify({ lat: 0, lng: 0.04 }) });

    expect((await run('split', 1, ORIGIN)).map((c) => c.driverId)).toEqual(['d1']);
  });

  it('split rides: a driver whose destination is just over 5 km away (0.045 deg lng = 5.004 km) is excluded', async () => {
    await seedGeo('d1', 0.02);
    await seedDetails('d1', { seats: '4', destination: JSON.stringify({ lat: 0, lng: 0.045 }) });

    expect(await run('split', 1, ORIGIN)).toEqual([]);
  });

  it('split rides: a driver without a stored destination is not filtered by destination', async () => {
    await seedGeo('d1', 0.02);
    await seedDetails('d1', { seats: '4' });

    expect((await run('split', 1)).map((c) => c.driverId)).toEqual(['d1']);
  });

  it('split rides: an unparsable destination is ignored instead of failing the search', async () => {
    await seedGeo('d1', 0.02);
    await seedDetails('d1', { seats: '4', destination: '{nope' });

    expect((await run('split', 1)).map((c) => c.driverId)).toEqual(['d1']);
  });

  it('private rides ignore the destination filter entirely', async () => {
    await seedGeo('d1', 0.02);
    await seedDetails('d1', { seats: '4', destination: JSON.stringify({ lat: 0, lng: 0.5 }) });

    expect((await run('private', 1)).map((c) => c.driverId)).toEqual(['d1']);
  });

  it('a driver found in both Redis and the DB appears only once', async () => {
    await seedGeo('d1', 0.02);
    await seedDetails('d1', { seats: '4' });
    vi.mocked(User.find).mockReturnValue(
      mockQuery([{ _id: { toString: () => 'd1' }, location: { coordinates: [0.02, 0] } }]) as any,
    );

    expect((await run()).map((c) => c.driverId)).toEqual(['d1']);
  });
});

describe('isPointNearRoute (10 km corridor)', () => {
  // Meridian route from (lat 0, lng 0) to (lat 0, lng 1). Coordinates are [lng, lat].
  const route = [
    [0, 0],
    [1, 0],
  ];

  it('returns false for an empty or missing route', () => {
    expect(isPointNearRoute(0, 0, [])).toBe(false);
    expect(isPointNearRoute(0, 0, undefined as unknown as number[][])).toBe(false);
  });

  it('LIMITATION: a single-point route is never a corridor, even if the point sits on it', () => {
    expect(isPointNearRoute(0, 0, [[0, 0]])).toBe(false);
  });

  it('returns true for a point on the route', () => {
    expect(isPointNearRoute(0, 0.5, route)).toBe(true);
  });

  it('returns true for a point 9.9 km off the route (inside the 10 km corridor)', () => {
    // 0.089 deg latitude ~ 9.896 km
    expect(isPointNearRoute(0.089, 0.5, route)).toBe(true);
  });

  it('returns false for a point 10.06 km off the route (outside the corridor)', () => {
    // 0.0905 deg latitude ~ 10.064 km
    expect(isPointNearRoute(0.0905, 0.5, route)).toBe(false);
  });

  it('clamps to the segment end: a point 0.08 deg beyond the end (~8.9 km) is near', () => {
    expect(isPointNearRoute(0, 1.08, route)).toBe(true);
  });

  it('clamps to the segment end: a point 0.1 deg beyond the end (~11.1 km) is not near', () => {
    expect(isPointNearRoute(0, 1.1, route)).toBe(false);
  });

  it('does not project past the end when the point lies on the extension of the segment (1.5 deg)', () => {
    expect(isPointNearRoute(0, 1.5, route)).toBe(false);
  });

  it('checks every segment of a multi-point route', () => {
    const bent = [
      [0, 0],
      [1, 0],
      [1, 1],
    ];
    // Near the second segment (lng 1, lat 0..1) but far from the first.
    expect(isPointNearRoute(0.5, 1.0, bent)).toBe(true);
  });

  it('treats a degenerate (zero-length) segment as a point', () => {
    expect(isPointNearRoute(0, 0.05, [[0, 0], [0, 0]])).toBe(true);
    expect(isPointNearRoute(0, 0.2, [[0, 0], [0, 0]])).toBe(false);
  });
});
