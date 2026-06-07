// handlers/ride/findNearbySplitRide.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import {
  fetchDriversWithinRadius,
  haversineMeters,
} from '../../../utils/geo.utils';
import { getRealDistanceAndETA } from '../../../utils/maps.utils';
import { TSocket } from '../../interface/socket.interface';
import eventHandler from '../../utils/eventHandler';
import { Ride } from '../../../modules/ride/ride.model';
import { User } from '../../../modules/user/user.model';
import { Vehicle } from '../../../modules/vehicle/vehicle.model';
import { RIDE_STATUS, RIDE_TYPE } from '../../../modules/ride/ride.constant';
import { TUser } from '../../../modules/user/user.interface';
import { TVehicle } from '../../../modules/vehicle/vehicle.interface';
import { Passenger } from '../../../modules/passenger/passenger.model';

export interface ISplitRideRequest {
  pickup: { lat: number; lng: number; address?: string };
  destination: { lat: number; lng: number; address?: string };
  departureDate: string; // ISO date string
  departureTime: string; // ISO time string
  passengers: number;
}

export const findNearbySplitRideHandler = eventHandler<ISplitRideRequest>(
  async (
    socket: TSocket,
    data: ISplitRideRequest | undefined,
    callback?: any
  ) => {
    try {
      if (!data) {
        return callback?.({ success: false, message: 'Invalid data' });
      }
      const { pickup, destination, departureDate, departureTime, passengers } =
        data;
      const redisClient = getRedisClient();
      type GeoRadiusResult = Array<[driverId: string, distance: string]>;
      let nearbyDrivers = (await redisClient.georadius(
        'drivers:location',
        pickup.lng,
        pickup.lat,
        5,
        'km',
        'WITHDIST'
      )) as GeoRadiusResult;

      if (nearbyDrivers.length === 0) {
        nearbyDrivers = (await redisClient.georadius(
          'drivers:location',
          pickup.lng,
          pickup.lat,
          10,
          'km',
          'WITHDIST'
        )) as GeoRadiusResult;
      }
      const nearbyDriverIds = nearbyDrivers.map((entry) => entry[0]);
      const nearbyDriverLocations = await Promise.all(
        nearbyDriverIds.map(async (driverId) => {
          const currentRaw = await redisClient.get(
            `driver:${driverId}:current`
          );
          if (currentRaw) {
            const current = JSON.parse(currentRaw);
            return {
              driverId,
              lat: current.lat,
              lng: current.lng,
            };
          }
          return null;
        })
      );

      const CORRIDOR_RADIUS_METERS = 300;
      const EARTH_RADIUS_METERS = 6378100;

      const rides = await Ride.find({
        type: RIDE_TYPE.split,
        status: RIDE_STATUS.accepted,
        departureDate,
        departureTime,
        driverId: { $in: nearbyDriverIds },
        totalSeats: { $gte: passengers },
        // Both pickup AND destination must have a matching point on the route within the corridor radius
        $and: [
          {
            'routeGeometry.coordinates': {
              $elemMatch: {
                $geoWithin: {
                  $centerSphere: [
                    [pickup.lng, pickup.lat],
                    CORRIDOR_RADIUS_METERS / EARTH_RADIUS_METERS,
                  ],
                },
              },
            },
          },
          {
            'routeGeometry.coordinates': {
              $elemMatch: {
                $geoWithin: {
                  $centerSphere: [
                    [destination.lng, destination.lat],
                    CORRIDOR_RADIUS_METERS / EARTH_RADIUS_METERS,
                  ],
                },
              },
            },
          },
        ],
      })
        .populate<{ driverId: TUser }>(
          'driverId',
          'name profileImage avgRating phone gender'
        )
        .populate<{ vehicleId: TVehicle }>(
          'vehicleId',
          'name number year seats'
        )
        .lean();
      const ridesIds = rides.map((r: any) => r._id.toString());
      const passengersInfos = await Passenger.find({
        rideId: { $in: ridesIds },
      })
        .select('rideId requestedSeats malePassengers femalePassengers')
        .lean();

      // Direction filter
      const directionFilteredRides = rides.filter((ride: any) => {
        const coords = ride.routeGeometry?.coordinates ?? [];

        let pickupIdx = -1,
          destIdx = -1;
        let pickupDist = Infinity,
          destDist = Infinity;

        coords.forEach(([lng, lat]: [number, number], i: number) => {
          const pd = haversineMeters(pickup.lat, pickup.lng, lat, lng);
          const dd = haversineMeters(
            destination.lat,
            destination.lng,
            lat,
            lng
          );

          if (pd < pickupDist) {
            pickupDist = pd;
            pickupIdx = i;
          }
          if (dd < destDist) {
            destDist = dd;
            destIdx = i;
          }
        });

        return (
          pickupDist <= CORRIDOR_RADIUS_METERS &&
          destDist <= CORRIDOR_RADIUS_METERS &&
          destIdx > pickupIdx
        );
      });

      // Group passengers by rideId
      const passengersByRideId = passengersInfos.reduce(
        (acc: Record<string, typeof passengersInfos>, passenger: any) => {
          const key = passenger.rideId.toString();
          if (!acc[key]) acc[key] = [];
          acc[key].push(passenger);
          return acc;
        },
        {}
      );

      // Driver current location map
      const driverLocationMap = nearbyDriverLocations.reduce(
        (acc: Record<string, { lat: number; lng: number } | null>, entry) => {
          if (entry) acc[entry.driverId] = { lat: entry.lat, lng: entry.lng };
          return acc;
        },
        {}
      );

      // Shape final response
      const result = directionFilteredRides.map((ride: any) => {
        const driver = ride.driverId as TUser & { _id: any };
        const vehicle = ride.vehicleId as TVehicle & { _id: any };
        const ridePassengers = passengersByRideId[ride._id.toString()] ?? [];

        const totalRequestedSeats = ridePassengers.reduce(
          (sum: number, p: any) => sum + (p.requestedSeats ?? 0),
          0
        );
        const totalMale = ridePassengers.reduce(
          (sum: number, p: any) => sum + (p.malePassengers ?? 0),
          0
        );
        const totalFemale = ridePassengers.reduce(
          (sum: number, p: any) => sum + (p.femalePassengers ?? 0),
          0
        );

        return {
          ride: {
            _id: ride._id,
            type: ride.type,
            status: ride.status,
            pickup: ride.pickup,
            destination: ride.destination,
            departureDate: ride.departureDate,
            departureTime: ride.departureTime,
            totalSeats: ride.totalSeats,
            bookedSeats: ride.bookedSeats,
          },
          driver: {
            _id: driver?._id,
            name: driver?.name,
            profileImage: driver?.profileImage,
            avgRating: driver?.avgRating,
            phone: driver?.phone,
            gender: driver?.gender,
            currentLocation: driverLocationMap[driver?._id?.toString()] ?? null,
          },
          vehicle: {
            _id: vehicle?._id,
            name: vehicle?.name,
            number: vehicle?.number,
            year: vehicle?.year,
            seats: vehicle?.seats,
          },
          passengers: {
            count: ridePassengers.length,
            totalRequestedSeats,
            totalMale,
            totalFemale,
          },
        };
      });
      callback?.({
        success: true,
        message: 'All Nearby split rides fetched successfully',
        data: result,
      });
    } catch (error) {
      console.error('Error in findNearbySplitRideHandler:', error);
      callback?.({ success: false, message: 'Internal server error' });
    }
  }
);
