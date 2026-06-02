export interface ILogin{
  email: string;
  password: string;
}
export interface IVerifyEmail {
  email: string;
  otp: number;
}
export interface IResetPassword {
  email: string;
  newPassword: string;
}

export interface IChangePassword {
  oldPassword: string;
  newPassword: string;
}
