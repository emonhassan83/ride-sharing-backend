import mongoose, { Schema } from 'mongoose';
import { TSavedPlaces, TSavedPlacesModel } from './savedPlaces.interface';

const savedPlacesSchema = new Schema<TSavedPlaces>(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User ID is required'],
    },
    label: {
      type: String,
      required: [true, 'Label is required'],
      trim: true,
      maxlength: 100,
    },
    streetName: {
      type: String,
      required: [true, 'Street name is required'],
      trim: true,
    },
    streetNumber: {
      type: String,
      required: [true, 'Street number is required'],
      trim: true,
    },
    district: {
      type: String,
      required: [true, 'District is required'],
      trim: true,
    },
    municipality: {
      type: String,
      required: [true, 'Municipality is required'],
      trim: true,
    },
    zip: {
      type: Number,
      required: [true, 'ZIP code is required'],
    },
    location: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point',
      },
      coordinates: {
        type: [Number],
        required: [true, 'Coordinates are required'],
      },
    },
    isPinned: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// Indexes
savedPlacesSchema.index({ user: 1 });
savedPlacesSchema.index({ 'location.coordinates': '2dsphere' });
savedPlacesSchema.index({ user: 1, isPinned: 1 });

// Only one pinned place per user
savedPlacesSchema.pre('save', async function () {
  if (this.isPinned) {
    await mongoose.model('UserLocation').updateMany(
      { user: this.user, isPinned: true, _id: { $ne: this._id } },
      { isPinned: false }
    );
  }
});

export const UserLocation = mongoose.model<TSavedPlaces, TSavedPlacesModel>(
  'UserLocation',
  savedPlacesSchema
);