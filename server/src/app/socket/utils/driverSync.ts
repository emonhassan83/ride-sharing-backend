import { PassengerService } from '../../modules/passenger/passenger.service';

/**
 * Tell a driver's app the server's view of its state (issues 58 / 63).
 *
 *  - `driver:status { isOnline }` lets the app correct its online toggle after a
 *    reconnect. Before this the server never sent it, so the toggle and the DB
 *    could disagree ("reopened the app and it put me offline").
 *  - `ride:pending-requests { count, requests }` replays every request this
 *    driver was already notified about and has not answered. A `ride:new-request`
 *    sent while the socket was down is otherwise lost: each driver is notified
 *    once per ride, so nothing would ever re-send it.
 *
 * Same list as REST `GET /api/v1/passenger/ride-requests` (getDriverRideRequest).
 */
export async function syncDriverState(
  socket: { emit: (event: string, ...args: any[]) => any },
  driverId: string,
  isOnline: boolean,
): Promise<void> {
  socket.emit('driver:status', { isOnline });
  if (!isOnline) return;

  try {
    const requests = await PassengerService.getDriverRideRequest(driverId);
    socket.emit('ride:pending-requests', { count: requests.length, requests });
  } catch (error: any) {
    console.error(`driver pending-request replay failed for ${driverId}:`, error?.message);
  }
}
