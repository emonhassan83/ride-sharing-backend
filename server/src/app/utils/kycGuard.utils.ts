// Drivers must be KYC verified before they can go online or accept rides.
// Dispatch (notifyDrivers.utils) already skips unverified drivers; the socket
// handlers use the same User.isKycVerified flag so a driver cannot bypass it
// by emitting driver:go-online / driver:accept-ride directly.

export const KYC_NOT_VERIFIED_MESSAGE =
  'Your KYC verification is not complete. You can go online and accept rides once your documents are approved.';

export const isDriverKycVerified = (
  user: { isKycVerified?: boolean | null } | null | undefined,
): boolean => user?.isKycVerified === true;
