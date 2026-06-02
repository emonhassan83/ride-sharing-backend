import mongoose, { Schema } from 'mongoose';
import { TBooking, TBookingModel } from './booking.interface';
import { BOOKING_STATUS, PAYMENT_STATUS } from './booking.constant';
import { generateCryptoString } from '../../utils/generateCryptoString';

const bookingSchema = new Schema<TBooking>(
  {
    id: {
      type: String,
      unique: true,
      default: () => generateCryptoString(10),
    },
    passengerId: {
      type: Schema.Types.ObjectId,
      ref: 'Passenger',
      required: [true, 'Passenger ID is required'],
    },
    rideId: {
      type: Schema.Types.ObjectId,
      ref: 'Ride',
      required: [true, 'Ride ID is required'],
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User ID is required'],
    },
    driverId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Driver ID is required'],
    },

    totalFare: {
      type: Number,
      required: true,
      min: 0,
    },
    amountPaid: {
      type: Number,
      required: true,
      min: 0,
    },

    bookingStatus: {
      type: String,
      enum: Object.values(BOOKING_STATUS),
      default: BOOKING_STATUS.pending,
    },
    paymentStatus: {
      type: String,
      enum: Object.values(PAYMENT_STATUS),
      default: PAYMENT_STATUS.pending,
    },

    transactionId: { type: String },
    refundAmount: { type: Number },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// Indexes
bookingSchema.index({ rideId: 1 });
bookingSchema.index({ passengerId: 1 });
bookingSchema.index({ userId: 1, bookingStatus: 1 });
bookingSchema.index({ driverId: 1, bookingStatus: 1 });
bookingSchema.index({ paymentStatus: 1 });

export const Booking = mongoose.model<TBooking, TBookingModel>(
  'Booking',
  bookingSchema
);
