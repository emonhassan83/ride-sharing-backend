// handlers/driver/driverAcceptRide.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import {
  BOOKING_STATUS,
  PAYMENT_STATUS,
} from '../../../modules/booking/booking.constant';
import { Booking } from '../../../modules/booking/booking.model';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { RIDE_STATUS, RIDE_TYPE } from '../../../modules/ride/ride.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { TSocket } from '../../interface/socket.interface';
import { getIO } from '../../socket.init';
import onlineUsers from '../../utils/onlineUsers';
import eventHandler from '../../utils/eventHandler';

// ─── Helper: rider কে ride room এ join করাও ─────────────────────────────────
const ensureRiderInRoom = (userId: string, rideId: string) => {
  const riderSocket = onlineUsers[userId]
  if (riderSocket) {
    riderSocket.join(`ride:${rideId}`)
    console.log(`✅ Rider ${userId} joined room: ride:${rideId}`)
  } else {
    console.log(`⚠️  Rider ${userId} is offline — cannot join room ride:${rideId}`)
  }
}

// ─── Helper: accepted payload builder ────────────────────────────────────────
const buildAcceptedPayload = (
  rideId: string,
  passenger: any,
  booking: any,
  driverId: string,
  driverDetails: any,
  socket: TSocket,
  estimatedArrival: number,
  extra?: Record<string, any>,
) => ({
  rideId,
  passengerId:      passenger._id,
  bookingId:        booking._id,
  driverId,
  driverName:       driverDetails.name   || socket.auth?.name   || '',
  driverPhone:      driverDetails.phone  || socket.auth?.phone  || '',
  driverPhoto:      driverDetails.photo  || socket.auth?.photo  || '',
  carModel:         driverDetails.vehicleModel  || 'Standard',
  carNumber:        driverDetails.vehicleNumber || '',
  estimatedArrival,
  totalFare:        passenger.estimatedFare,
  status:           'confirmed',
  ...extra,
})

export const driverAcceptRideHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    let { rideId, passengerId, estimatedArrival = 5, acceptType = 'single' } = data
    const driverId = socket.auth?._id?.toString()

    if (!driverId || !rideId) {
      return callback?.({ success: false, message: 'Missing required fields' })
    }

    try {
      const redis = getRedisClient()
      const io    = getIO()

      // ─── Driver details from Redis ──────────────────────────────────
      const driverDetails = await redis.hgetall(`driver:${driverId}:details`)
      if (!driverDetails || Object.keys(driverDetails).length === 0) {
        return callback?.({ success: false, message: 'Driver data not found' })
      }

      const totalSeats     = parseInt(driverDetails.seats)       || 4
      const bookedSeats    = parseInt(driverDetails.bookedSeats) || 0
      const availableSeats = totalSeats - bookedSeats

      const ride = await Ride.findById(rideId)
      if (!ride) {
        return callback?.({ success: false, message: 'Ride not found' })
      }

      // ─── Driver joins ride room ─────────────────────────────────────
      socket.join(`ride:${rideId}`)
      socket.join(`driver:${driverId}`)
      console.log(`✅ Driver ${driverId} joined room: ride:${rideId}`)

      // ═══════════════════════════════════════════════════════════════
      // CASE 1: Private Ride
      // ═══════════════════════════════════════════════════════════════
      if (ride.type === RIDE_TYPE.private) {
        const passenger = await Passenger.findOne({
          rideId,
          status: PASSENGER_STATUS.searching,
        })
        if (!passenger) {
          return callback?.({ success: false, message: 'No pending passenger found' })
        }

        if (availableSeats < (passenger.requestedSeats || 1)) {
          return callback?.({
            success: false,
            message: `Not enough seats. Only ${availableSeats} available, but ${passenger.requestedSeats || 1} requested.`,
          })
        }

        await Ride.findByIdAndUpdate(rideId, {
          driverId,
          status: RIDE_STATUS.accepted,
        })

        await redis.hincrby(`driver:${driverId}:details`, 'bookedSeats', passenger.requestedSeats || 1)

        const booking = await Booking.create({
          passengerId:    passenger._id,
          rideId:         ride._id,
          userId:         passenger.userId,
          driverId,
          totalFare:      passenger.estimatedFare,
          amountPaid:     0,
          bookingStatus:  BOOKING_STATUS.accepted,
          paymentStatus:  PAYMENT_STATUS.pending,
        })

        passenger.status = PASSENGER_STATUS.confirmed
        await passenger.save()

        await redis.hset(`ride:active:${rideId}`, {
          driverId,
          status:         RIDE_STATUS.accepted,
          startedAt:      Date.now().toString(),
          passengerCount: '1',
        })
        await redis.expire(`ride:active:${rideId}`, 7200)

        // ✅ Rider কে ride room এ join করাও
        ensureRiderInRoom(passenger.userId.toString(), rideId)

        const payload = buildAcceptedPayload(
          rideId, passenger, booking, driverId, driverDetails, socket,
          estimatedArrival, { rideFullyAccepted: true },
        )

        // ✅ ride room এ emit করো — driver + rider দুজনেই পাবে
        io.to(`ride:${rideId}`).emit('booking:payment-confirmed', payload)
        io.to(`ride:${rideId}`).emit('ride:driver-accepted', payload)

        console.log(`✅ Private ride accepted | rideId: ${rideId} | passengerId: ${passenger._id}`)

        return callback?.({
          success:   true,
          message:   'Private ride accepted successfully',
          bookingId: booking._id,
        })
      }

      // ═══════════════════════════════════════════════════════════════
      // CASE 2: Split Ride — Accept ALL passengers
      // ═══════════════════════════════════════════════════════════════
      if (acceptType === 'all') {
        const passengers = await Passenger.find({
          rideId,
          status: PASSENGER_STATUS.searching,
        })
        if (!passengers.length) {
          return callback?.({ success: false, message: 'No pending passengers for this ride' })
        }

        const totalRequestedSeats = passengers.reduce(
          (sum, p) => sum + (p.requestedSeats || 1), 0,
        )
        if (availableSeats < totalRequestedSeats) {
          return callback?.({
            success: false,
            message: `Not enough seats. Only ${availableSeats} available, but ${totalRequestedSeats} requested.`,
          })
        }

        await Ride.findByIdAndUpdate(rideId, {
          driverId,
          status: RIDE_STATUS.accepted,
        })

        await redis.hincrby(`driver:${driverId}:details`, 'bookedSeats', totalRequestedSeats)

        const bookings = []

        for (const passenger of passengers) {
          const booking = await Booking.create({
            passengerId:   passenger._id,
            rideId:        ride._id,
            userId:        passenger.userId,
            driverId,
            totalFare:     passenger.estimatedFare,
            amountPaid:    0,
            bookingStatus: BOOKING_STATUS.accepted,
            paymentStatus: PAYMENT_STATUS.pending,
          })
          bookings.push(booking)

          passenger.status = PASSENGER_STATUS.confirmed
          await passenger.save()

          // ✅ প্রতিটি rider কে ride room এ join করাও
          ensureRiderInRoom(passenger.userId.toString(), rideId)

          const payload = buildAcceptedPayload(
            rideId, passenger, booking, driverId, driverDetails, socket,
            estimatedArrival, { rideFullyAccepted: true },
          )

          // ✅ ride room এ emit — driver + rider পাবে
          io.to(`ride:${rideId}`).emit('booking:payment-confirmed', payload)
          io.to(`ride:${rideId}`).emit('ride:driver-accepted', payload)
        }

        await redis.hset(`ride:active:${rideId}`, {
          driverId,
          status:         RIDE_STATUS.accepted,
          startedAt:      Date.now().toString(),
          passengerCount: passengers.length.toString(),
        })
        await redis.expire(`ride:active:${rideId}`, 7200)

        console.log(`✅ Split ride (all) accepted | rideId: ${rideId} | passengers: ${passengers.length}`)

        return callback?.({
          success:       true,
          message:       `Whole ride accepted. ${totalRequestedSeats} seat(s) booked.`,
          bookingsCount: bookings.length,
        })
      }

      // ═══════════════════════════════════════════════════════════════
      // CASE 3: Split Ride — Accept SINGLE passenger
      // ═══════════════════════════════════════════════════════════════
      if (acceptType === 'single' && passengerId) {
        const passenger = await Passenger.findOne({
          _id:    passengerId,
          rideId,
          status: PASSENGER_STATUS.searching,
        })
        if (!passenger) {
          return callback?.({ success: false, message: 'Passenger not found or already processed' })
        }

        const requestedSeats = passenger.requestedSeats || 1
        if (availableSeats < requestedSeats) {
          return callback?.({
            success: false,
            message: `Not enough seats. Only ${availableSeats} available, but ${requestedSeats} requested.`,
          })
        }

        const otherPassengersCount = await Passenger.countDocuments({
          rideId,
          _id:    { $ne: passenger._id },
          status: PASSENGER_STATUS.searching,
        })
        const hasOtherPassengers = otherPassengersCount > 0

        await redis.hincrby(`driver:${driverId}:details`, 'bookedSeats', requestedSeats)

        const booking = await Booking.create({
          passengerId:   passenger._id,
          rideId:        ride._id,
          userId:        passenger.userId,
          driverId,
          totalFare:     passenger.estimatedFare,
          amountPaid:    0,
          bookingStatus: BOOKING_STATUS.accepted,
          paymentStatus: PAYMENT_STATUS.pending,
        })

        passenger.status = PASSENGER_STATUS.confirmed
        await passenger.save()

        if (!hasOtherPassengers) {
          await Ride.findByIdAndUpdate(rideId, {
            driverId,
            status: RIDE_STATUS.accepted,
          })
          await redis.hset(`ride:active:${rideId}`, {
            driverId,
            status:         RIDE_STATUS.accepted,
            startedAt:      Date.now().toString(),
            passengerCount: '1',
          })
          await redis.expire(`ride:active:${rideId}`, 7200)
        } else {
          if (!ride.driverId) {
            await Ride.findByIdAndUpdate(rideId, { driverId })
          }
        }

        // ✅ Rider কে ride room এ join করাও
        ensureRiderInRoom(passenger.userId.toString(), rideId)

        const payload = buildAcceptedPayload(
          rideId, passenger, booking, driverId, driverDetails, socket,
          estimatedArrival, {
            rideFullyAccepted:    !hasOtherPassengers,
            remainingPassengers:  hasOtherPassengers ? otherPassengersCount : 0,
          },
        )

        // ✅ ride room এ emit — driver + rider পাবে
        io.to(`ride:${rideId}`).emit('booking:payment-confirmed', payload)
        io.to(`ride:${rideId}`).emit('ride:driver-accepted', payload)

        console.log(
          `✅ Split ride (single) accepted | rideId: ${rideId} | passengerId: ${passengerId} | othersLeft: ${otherPassengersCount}`,
        )

        return callback?.({
          success:           true,
          message:           hasOtherPassengers
            ? `Passenger accepted. ${otherPassengersCount} passenger(s) still searching.`
            : 'Passenger accepted. Ride fully booked.',
          bookingId:         booking._id,
          rideFullyAccepted: !hasOtherPassengers,
        })
      }

      callback?.({
        success: false,
        message: 'Invalid acceptType or missing passengerId for single acceptance',
      })
    } catch (error) {
      console.error('❌ Error in driverAcceptRideHandler:', error)
      callback?.({ success: false, message: 'Internal server error' })
    }
  },
)