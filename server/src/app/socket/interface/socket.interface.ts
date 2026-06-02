import { Socket } from 'socket.io';
import { TUserRole } from '../../modules/user/user.constant';

export interface TSocketUser {
  _id: string;
  email: string;
  role: TUserRole;
  name?: string;
  phone?: string;
  photo?: string;
  vehicle?: {
    model: string;
    number: string;
    year?: number;
    seats?: number;
  };
  lastLocation?: {
    lat: number;
    lng: number;
    updatedAt: number;
  };
  avgRating?: number;
}

export type TAckRes = { success: boolean; message?: string; data?: any };
export type TAckFn = (response: TAckRes) => void;

export type TSocketHandler<TData = any> = (
  socket: TSocket,
  data?: TData,      // ✅ optional
  ack?: TAckFn,
) => Promise<void>

export type TError = {
  message: string;
  statusCode?: number;
};

export type TSocket = Socket & {
  auth: TSocketUser;
  data?: { user?: any };
};
