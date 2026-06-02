import { Model, Types } from 'mongoose';

export interface TSavedPlaces {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  label: string;
  streetName: string;
  streetNumber: string;
  district: string;
  municipality: string
  zip: number
  location: {
    type: 'Point';
    coordinates: [number, number];
  };
  isPinned: boolean
  createdAt: Date;
  updatedAt: Date;
}

export type TSavedPlacesModel = Model<TSavedPlaces>;
