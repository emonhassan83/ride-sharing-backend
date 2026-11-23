// src/app/socket/utils/handleSocketError.ts
import { Socket } from "socket.io";
import { TAckFn } from "../interface/index.interface";
import ackHandler from "./ackHandler";
import ApiError from "../../errors/ApiError";
import { translateText } from "../../i18n/i18n";

// B-22: every socket error now carries a stable, machine-readable `code` the
// app can translate or map to UI, and unexpected errors no longer leak their
// internal message (Mongo/TypeError text) or the raw error object to users.
const CODE_BY_STATUS: Record<number, string> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  422: "VALIDATION_ERROR",
  429: "TOO_MANY_REQUESTS",
  500: "INTERNAL_ERROR",
  502: "UPSTREAM_ERROR",
};

const GENERIC_MESSAGE = "Something went wrong!";

export const handleSocketError = (err: any, socket: Socket, ack?: TAckFn) => {
  let status = 500;
  let message = GENERIC_MESSAGE;
  let code = "INTERNAL_ERROR";
  let details: Record<string, unknown> | undefined;

  if (err?.name === "ValidationError") {
    status = 422;
    code = "VALIDATION_ERROR";
    message = "Validation error!";
    const fieldErrors: Record<string, string> = {};
    for (const field in err.errors) {
      fieldErrors[field] = err.errors[field].message;
    }
    details = { fields: fieldErrors };
  } else if (err?.code === 11000) {
    status = 409;
    code = "DUPLICATE_KEY";
    const field = Object.keys(err.keyValue || {})[0];
    message = `Field '${field}' must be unique!`;
    details = { path: field };
  } else if (err?.name === "CastError") {
    status = 400;
    code = "INVALID_VALUE";
    message = `Invalid value for field '${err.path}'!`;
    details = { path: err.path };
  } else if (err instanceof ApiError) {
    status = Number(err.code) || 500;
    code = (err as any).errorCode || CODE_BY_STATUS[status] || "ERROR";
    // ApiError messages are written for users; 5xx ones may not be.
    message = status >= 500 ? GENERIC_MESSAGE : err.message || GENERIC_MESSAGE;
  } else if (err?.name === "JsonWebTokenError") {
    status = 401;
    code = "INVALID_TOKEN";
    message = "Invalid token!";
  } else if (err?.name === "TokenExpiredError") {
    status = 401;
    code = "TOKEN_EXPIRED";
    message = "Token expired!";
  } else {
    // Unknown error: log it for us, show users a safe message only.
    console.error("Unhandled socket error:", err?.message || err);
  }

  const localizedMessage = translateText(message);
  const response = {
    success: false,
    status,
    code,
    message: localizedMessage,
    ...(details ? { details } : {}),
  };

  if (ack && typeof ack === "function") {
    ackHandler(ack, response);
  }

  // Kept alongside the ack for existing app builds; the app can now decide by
  // `code` which errors deserve a snackbar.
  if (socket && typeof socket.emit === "function") {
    socket.emit("socketError", response);
  } else {
    console.error("❌ Cannot emit socketError: socket.emit is not a function");
  }
};
