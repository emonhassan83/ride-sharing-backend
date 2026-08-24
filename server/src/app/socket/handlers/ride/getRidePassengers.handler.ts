// handlers/driver/getActivePassengers.handler.ts
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { Booking } from '../../../modules/booking/booking.model';
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

    const passengers = await Passenger.find({
      rideId,
      status: { $in: [
        PASSENGER_STATUS.confirmed,
        PASSENGER_STATUS.driver_arrived,
        PASSENGER_STATUS.in_progress,
        PASSENGER_STATUS.picked_up,
        PASSENGER_STATUS.dropped_off,
        PASSENGER_STATUS.completed,
      ]},
    })
      .select('userId pickup destination status requestedSeats estimatedFare pickedUpAt arriveAt')
      .lean();

    if (!passengers.length) {
      return callback?.({
        success: true,
        message: 'No passengers found for this ride',
        data:    { passengers: [], totalCount: 0 },
      });
    }

    // ✅ Batch fetch bookings for all passengers at once
    const passengerIds = passengers.map(p => p._id);
    const bookings     = await Booking.find({ passengerId: { $in: passengerIds } })
      .select('passengerId _id')
      .lean();

    const bookingMap = new Map(
      bookings.map(b => [b.passengerId.toString(), b._id]),
    );

    const enriched = await Promise.all(
      passengers.map(async (passenger) => {
        const user = await User.findById(passenger.userId)
          .select('name profileImage phone avgRating')
          .lean();

        const pickupLng      = passenger.pickup.coordinates[0];
        const pickupLat      = passenger.pickup.coordinates[1];
        const distanceMeters = haversineMeters(lat, lng, pickupLat, pickupLng);

        return {
          passengerId:    passenger._id,
          bookingId:      bookingMap.get(passenger._id.toString()) || null, // ✅
          status:         passenger.status,
          requestedSeats: passenger.requestedSeats,
          estimatedFare:  passenger.estimatedFare,
          name:           user?.name         || '',
          profileImage:   user?.profileImage || null,
          pickup: {
            address: passenger.pickup.address,
            lat:     pickupLat,
            lng:     pickupLng,
          },
          destination: {
            address: passenger.destination.address,
            lat:     passenger.destination.coordinates[1],
            lng:     passenger.destination.coordinates[0],
          },
          arriveAt:   passenger.arriveAt   || null,
          pickedUpAt: passenger.pickedUpAt || null,
        };
      }),
    );

    return callback?.({
      success: true,
      message: `${enriched.length} passenger(s) found`,
      data: {
        rideId,
        driverLocation: { lat, lng },
        passengers:     enriched,
        totalCount:     enriched.length,
      },
    });
  },
);

