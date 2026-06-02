import { Types } from 'mongoose';

interface ISetting {
  _id: Types.ObjectId;
  key: string;
  value: any;
}

export default ISetting;
