/**
 * Unit tests: maps.utils (Google Distance Matrix / Directions wrappers).
 * axios is mocked (no network). Redis is the global in-memory fake.
 *
 * Reference points on the equator: 0.1 deg of longitude = 6371 * 0.1 * PI / 180 = 11.11949 km.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import polyline from '@mapbox/polyline';
import { getRealDistanceAndETA, getRouteGeometry } from '@src/app/utils/maps.utils';
import { fakeRedis } from '@tests/helpers/fakeRedis';

vi.mock('axios', () => ({ default: { get: vi.fn() } }));

// location.utils (imported by maps.utils) loads the Ride model; keep Mongoose out of this file.
vi.mock('@src/app/modules/ride/ride.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Ride: createModelMock() };
});

const origin = { lat: 0, lng: 0 };
const destination = { lat: 0, lng: 0.1 };
const CACHE_KEY = 'map:distance:0.000000,0.000000:0.000000,0.100000';
const STRAIGHT_KM = 11.11949;
const STRAIGHT_MIN = 22; // round(11.11949 / 30 * 60) = round(22.239)

const apiElement = (element: unknown) => ({ data: { rows: [{ elements: [element] }] } });

describe('getRealDistanceAndETA', () => {
  beforeEach(() => {
    vi.mocked(axios.get).mockReset();
  });

  describe('Distance Matrix API path', () => {
    it('calls Distance Matrix with traffic-aware params and a 5s timeout', async () => {
      vi.mocked(axios.get).mockResolvedValue(
        apiElement({ status: 'OK', distance: { value: 11200 }, duration: { value: 600 } }),
      );

      await getRealDistanceAndETA(origin, destination);

      expect(axios.get).toHaveBeenCalledTimes(1);
      expect(axios.get).toHaveBeenCalledWith(
        'https://maps.googleapis.com/maps/api/distancematrix/json',
        {
          params: {
            origins: '0,0',
            destinations: '0,0.1',
            key: 'test-maps-key',
            units: 'metric',
            departure_time: 'now',
            traffic_model: 'best_guess',
          },
          timeout: 5000,
        },
      );
    });

    it('converts metres to km and prefers duration_in_traffic, rounding seconds up to minutes', async () => {
      vi.mocked(axios.get).mockResolvedValue(
        apiElement({
          status: 'OK',
          distance: { value: 11200 },
          duration: { value: 600 },
          duration_in_traffic: { value: 1321 }, // 22.0167 min -> ceil 23
        }),
      );

      const result = await getRealDistanceAndETA(origin, destination);

      expect(result).toEqual({ distanceKm: 11.2, durationMinutes: 23 });
    });

    it('falls back to duration.value when duration_in_traffic is missing', async () => {
      vi.mocked(axios.get).mockResolvedValue(
        apiElement({ status: 'OK', distance: { value: 11200 }, duration: { value: 600 } }),
      );

      const result = await getRealDistanceAndETA(origin, destination);

      expect(result).toEqual({ distanceKm: 11.2, durationMinutes: 10 });
    });

    it('estimates duration at 30 km/h when no duration value is returned', async () => {
      vi.mocked(axios.get).mockResolvedValue(
        apiElement({ status: 'OK', distance: { value: 11200 } }),
      );

      const result = await getRealDistanceAndETA(origin, destination);

      // 11.2 / 30 * 3600 = 1344 s -> ceil(22.4) = 23 min
      expect(result).toEqual({ distanceKm: 11.2, durationMinutes: 23 });
    });

    it('enforces a minimum of 1 minute for a zero-length trip (boundary)', async () => {
      vi.mocked(axios.get).mockResolvedValue(
        apiElement({ status: 'OK', distance: { value: 0 }, duration: { value: 0 } }),
      );

      const result = await getRealDistanceAndETA(origin, destination);

      expect(result).toEqual({ distanceKm: 0, durationMinutes: 1 });
    });

    it('rounds 1 second up to 1 minute (ceil boundary)', async () => {
      vi.mocked(axios.get).mockResolvedValue(
        apiElement({ status: 'OK', distance: { value: 500 }, duration: { value: 1 } }),
      );

      const result = await getRealDistanceAndETA(origin, destination);

      expect(result.durationMinutes).toBe(1);
      expect(result.distanceKm).toBe(0.5);
    });

    it('caches a successful result in Redis for 600 seconds', async () => {
      vi.mocked(axios.get).mockResolvedValue(
        apiElement({ status: 'OK', distance: { value: 11200 }, duration: { value: 600 } }),
      );

      await getRealDistanceAndETA(origin, destination);

      expect(JSON.parse(fakeRedis.peek(CACHE_KEY)!)).toEqual({ distanceKm: 11.2, durationMinutes: 10 });
      expect(await fakeRedis.ttl(CACHE_KEY)).toBe(600);
    });

    it('returns the cached value without calling the API on a cache hit', async () => {
      await fakeRedis.setex(CACHE_KEY, 600, JSON.stringify({ distanceKm: 7.5, durationMinutes: 14 }));

      const result = await getRealDistanceAndETA(origin, destination);

      expect(result).toEqual({ distanceKm: 7.5, durationMinutes: 14 });
      expect(axios.get).not.toHaveBeenCalled();
    });

    it('builds the cache key with 6-decimal precision (sub-micro-degree noise shares a key)', async () => {
      await fakeRedis.setex(CACHE_KEY, 600, JSON.stringify({ distanceKm: 3, durationMinutes: 6 }));

      const result = await getRealDistanceAndETA({ lat: 0.0000001, lng: 0 }, destination);

      expect(result).toEqual({ distanceKm: 3, durationMinutes: 6 });
      expect(axios.get).not.toHaveBeenCalled();
    });

    it('ignores a corrupted cache entry and asks the API instead', async () => {
      await fakeRedis.setex(CACHE_KEY, 600, '{not json');
      vi.mocked(axios.get).mockResolvedValue(
        apiElement({ status: 'OK', distance: { value: 2000 }, duration: { value: 300 } }),
      );

      const result = await getRealDistanceAndETA(origin, destination);

      expect(axios.get).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ distanceKm: 2, durationMinutes: 5 });
    });

    it('continues to the API when the Redis read fails', async () => {
      vi.spyOn(fakeRedis, 'get').mockRejectedValueOnce(new Error('redis down'));
      vi.mocked(axios.get).mockResolvedValue(
        apiElement({ status: 'OK', distance: { value: 4000 }, duration: { value: 240 } }),
      );

      const result = await getRealDistanceAndETA(origin, destination);

      expect(axios.get).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ distanceKm: 4, durationMinutes: 4 });
    });

    it('still returns the API result when the Redis cache write fails', async () => {
      vi.spyOn(fakeRedis, 'setex').mockRejectedValueOnce(new Error('redis down'));
      vi.mocked(axios.get).mockResolvedValue(
        apiElement({ status: 'OK', distance: { value: 4000 }, duration: { value: 240 } }),
      );

      const result = await getRealDistanceAndETA(origin, destination);

      expect(result).toEqual({ distanceKm: 4, durationMinutes: 4 });
    });

    it('falls back to straight-line distance and does NOT cache when the element status is not OK', async () => {
      vi.mocked(axios.get).mockResolvedValue(apiElement({ status: 'ZERO_RESULTS' }));

      const result = await getRealDistanceAndETA(origin, destination);

      expect(result.distanceKm).toBeCloseTo(STRAIGHT_KM, 4);
      expect(result.durationMinutes).toBe(STRAIGHT_MIN);
      expect(fakeRedis.peek(CACHE_KEY)).toBeNull();
    });

    it('falls back to straight-line distance when the rows array is empty', async () => {
      vi.mocked(axios.get).mockResolvedValue({ data: { rows: [] } });

      const result = await getRealDistanceAndETA(origin, destination);

      expect(result.distanceKm).toBeCloseTo(STRAIGHT_KM, 4);
      expect(result.durationMinutes).toBe(STRAIGHT_MIN);
    });

    it('falls back to straight-line distance when the HTTP request rejects', async () => {
      vi.mocked(axios.get).mockRejectedValue(new Error('timeout of 5000ms exceeded'));

      const result = await getRealDistanceAndETA(origin, destination);

      expect(result.distanceKm).toBeCloseTo(STRAIGHT_KM, 4);
      expect(result.durationMinutes).toBe(STRAIGHT_MIN);
      expect(fakeRedis.peek(CACHE_KEY)).toBeNull();
    });
  });

  describe('without a Google Maps API key', () => {
    it('uses straight-line distance at 30 km/h and never calls axios', async () => {
      vi.resetModules();
      vi.stubEnv('GOOGLE_MAPS_API_KEY', '');
      const mod = await import('@src/app/utils/maps.utils');

      const result = await mod.getRealDistanceAndETA(origin, destination);

      expect(result.distanceKm).toBeCloseTo(STRAIGHT_KM, 4);
      expect(result.durationMinutes).toBe(STRAIGHT_MIN);
      expect(axios.get).not.toHaveBeenCalled();
    });
  });
});

describe('getRouteGeometry', () => {
  beforeEach(() => {
    vi.mocked(axios.get).mockReset();
  });

  const encoded = polyline.encode([
    [38.5, -120.2],
    [40.7, -120.95],
    [43.252, -126.453],
  ]);

  it('decodes overview_polyline into a GeoJSON LineString with [lng, lat] order', async () => {
    vi.mocked(axios.get).mockResolvedValue({
      data: { routes: [{ overview_polyline: { points: encoded } }] },
    });

    const result = await getRouteGeometry({ lat: 38.5, lng: -120.2 }, { lat: 43.252, lng: -126.453 });

    expect(result).toEqual({
      type: 'LineString',
      coordinates: [
        [-120.2, 38.5],
        [-120.95, 40.7],
        [-126.453, 43.252],
      ],
    });
  });

  it('requests Directions with origin, destination and key params', async () => {
    vi.mocked(axios.get).mockResolvedValue({
      data: { routes: [{ overview_polyline: { points: encoded } }] },
    });

    await getRouteGeometry({ lat: 1, lng: 2 }, { lat: 3, lng: 4 });

    expect(axios.get).toHaveBeenCalledWith('https://maps.googleapis.com/maps/api/directions/json', {
      params: { origin: '1,2', destination: '3,4', key: 'test-maps-key' },
    });
  });

  it('throws "No route found" when routes is empty (boundary: 0 routes)', async () => {
    vi.mocked(axios.get).mockResolvedValue({ data: { routes: [] } });

    await expect(getRouteGeometry(origin, destination)).rejects.toThrow('No route found');
  });

  it('throws "No route found" when the first route has no overview_polyline', async () => {
    vi.mocked(axios.get).mockResolvedValue({ data: { routes: [{ legs: [] }] } });

    await expect(getRouteGeometry(origin, destination)).rejects.toThrow('No route found');
  });

  it('propagates HTTP errors from axios', async () => {
    vi.mocked(axios.get).mockRejectedValue(new Error('network down'));

    await expect(getRouteGeometry(origin, destination)).rejects.toThrow('network down');
  });

  it('CHARACTERIZATION: an empty encoded polyline yields a LineString with no coordinates', async () => {
    vi.mocked(axios.get).mockResolvedValue({
      data: { routes: [{ overview_polyline: { points: '' } }] },
    });

    const result = await getRouteGeometry(origin, destination);

    expect(result).toEqual({ type: 'LineString', coordinates: [] });
  });
});
