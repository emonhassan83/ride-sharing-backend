// src/app/socket/utils/handleSocketError.ts
import { Socket } from "socket.io";
import { TAckFn } from "../interface/index.interface";
import ackHandler from "./ackHandler";
import ApiError from "../../errors/ApiError";

export const handleSocketError = (err: any, socket: Socket, ack?: TAckFn) => {
  let status = 500;
  let message = "Something went wrong!";
  let error = err;

  if (err.name === "ValidationError") {
    status = 422;
    message = "Validation error!";
    const fieldErrors: Record<string, string> = {};
    for (const field in err.errors) {
      fieldErrors[field] = err.errors[field].message;
    }
    error = { message, fields: fieldErrors, code: "validation_error" };
  } 
  else if (err.code === 11000) {
    status = 409;
    const field = Object.keys(err.keyValue)[0];
    message = `Field '${field}' must be unique!`;
    error = { message, path: field, code: "duplicate_key" };
  } 
  else if (err.name === "CastError") {
    status = 400;
    message = `Invalid value for field '${err.path}'!`;
    error = { message, path: err.path, code: "invalid_value" };
  } 
  else if (err instanceof ApiError) {
    status = err.code;
    message = err.message;
  } 
  else if (err.name === "JsonWebTokenError") {
    status = 401;
    message = "Invalid token!";
  } 
  else if (err.name === "TokenExpiredError") {
    status = 401;
    message = "Token expired!";
  } 
  else if (err instanceof Error) {
    message = err.message || message;
  }

  // Send ack if provided
  if (ack && typeof ack === 'function') {
    ackHandler(ack, { success: false, message });
  }

  // **নিরাপদভাবে emit করুন**
  if (socket && typeof socket.emit === 'function') {
    socket.emit("socketError", {
      success: false,
      status,
      message,
      error,
    });
  } else {
    console.error('❌ Cannot emit socketError: socket.emit is not a function');
  }
};