// handlers/driver/getActivePassengers.handler.ts
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { Ride } from '../../../modules/ride/ride.model';
import { User } from '../../../modules/user/user.model';
import { haversineMeters } from '../../../utils/geo.utils';
import { TSocket } from '../../interface/index.interface';
import { RIDE_STATUS } from '../../../modules/ride/ride.constant';
import eventHandler from '../../utils/eventHandler';

export const getRidePassengersHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const { rideId, lat, lng } = data;
    const driverId = socket.auth?._id?.toString();

    if (!driverId)
      return callback?.({ success: false, message: 'Unauthorized' });
    if (!rideId)
      return callback?.({ success: false, message: 'Missing rideId' });
    if (lat == null || lng == null)
      return callback?.({ success: false, message: 'Missing driver location (lat, lng)' });

    // ── Ride validation ───────────────────────────────────────────────────────
    const ride = await Ride.findById(rideId).lean();
    if (!ride)
      return callback?.({ success: false, message: 'Ride not found' });

    if (ride.driverId?.toString() !== driverId)
      return callback?.({ success: false, message: 'You are not assigned to this ride' });

    const validStatuses = [RIDE_STATUS.accepted, RIDE_STATUS.started, RIDE_STATUS.completed];
    if (!validStatuses.includes(ride.status as any))
      return callback?.({
        success: false,
        message: `Cannot get passengers — ride status: ${ride.status}`,
      });

    // ── Find in_progress passengers ───────────────────────────────────────────
    const passengers = await Passenger.find({
      rideId,
      status: { $in: [
        PASSENGER_STATUS.confirmed,
        PASSENGER_STATUS.driver_arrived,
        PASSENGER_STATUS.in_progress,
        PASSENGER_STATUS.picked_up,
      ]},
    })
      .select('userId pickup destination status requestedSeats estimatedFare pickedUpAt arriveAt')
      .lean();

    if (!passengers.length) {
      return callback?.({
        success: true,
        message: 'No active passengers found',
        data:    { passengers: [], totalCount: 0 },
      });
    }

    // ── Enrich with user info + distance from driver ───────────────────────────
    const enriched = await Promise.all(
      passengers.map(async (passenger) => {
        // User info
        const user = await User.findById(passenger.userId)
          .select('name profileImage phone avgRating')
          .lean();

        // Pickup coordinates [lng, lat]
        const pickupLng = passenger.pickup.coordinates[0];
        const pickupLat = passenger.pickup.coordinates[1];

        // Distance from driver current location to passenger pickup (meters)
        const distanceMeters = haversineMeters(lat, lng, pickupLat, pickupLng);
        const distanceKm     = Math.round(distanceMeters / 10) / 100; // 2 decimal

        return {
          passengerId:   passenger._id,
          status:        passenger.status,
          requestedSeats: passenger.requestedSeats,
          estimatedFare: passenger.estimatedFare,

          // User info
          name:         user?.name         || '',
          profileImage: user?.profileImage || null,

          // Pickup
          pickup: {
            address: passenger.pickup.address,
            lat:     pickupLat,
            lng:     pickupLng,
          },

          // Destination
          destination: {
            address: passenger.destination.address,
            lat:     passenger.destination.coordinates[1],
            lng:     passenger.destination.coordinates[0],
          },

          // Distance from driver → passenger pickup
        //   distanceFromDriverKm: distanceKm,
        //   distanceFromDriverM:  Math.round(distanceMeters),

          // Trip timestamps
          arriveAt:   passenger.arriveAt   || null,
          pickedUpAt: passenger.pickedUpAt || null,
        };
      }),
    );

    // Sort by distance ascending (nearest passenger first)
    // enriched.sort((a, b) => a.distanceFromDriverM - b.distanceFromDriverM);

    return callback?.({
      success: true,
      message: `${enriched.length} active passenger(s) found`,
      data: {
        rideId,
        driverLocation: { lat, lng },
        passengers:     enriched,
      },
    });
  },
);