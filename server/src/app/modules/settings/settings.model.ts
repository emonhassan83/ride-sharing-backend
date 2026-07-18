import mongoose, { Schema } from 'mongoose';
import ISetting from './settings.interface';

const settingsSchema = new Schema<ISetting>(
  {
    key: {
      type: String,
      required: [true, 'Key is required'],
      unique: true,
      trim: true,
    },
    value: {
      type: Schema.Types.Mixed,
      required: [true, 'Value is required'],
    },
  },
);

export const Setting = mongoose.model<ISetting>('Setting', settingsSchema);
