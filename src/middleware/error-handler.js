import { ZodError } from "zod";
import { AppError } from "../utils/app-error.js";

export function notFoundHandler(_request, response) {
  response.status(404).json({
    success: false,
    data: null,
    message: "Route not found",
    error: { code: "NOT_FOUND" },
  });
}

export function errorHandler(error, _request, response, next) {
  if (response.headersSent) {
    next(error);
    return;
  }

  if (error instanceof ZodError) {
    response.status(400).json({
      success: false,
      data: null,
      message: "Request validation failed",
      error: {
        code: "VALIDATION_ERROR",
        details: error.issues.map(({ path, message }) => ({
          path: path.join("."),
          message,
        })),
      },
    });
    return;
  }

  if (error instanceof AppError) {
    response.status(error.statusCode).json({
      success: false,
      data: null,
      message: error.message,
      error: { code: error.code },
    });
    return;
  }

  if (error?.code === 11000) {
    response.status(409).json({
      success: false,
      data: null,
      message: "A record with the same unique value already exists",
      error: { code: "DUPLICATE_KEY" },
    });
    return;
  }

  if (error?.name === "MulterError") {
    const tooLarge = error.code === "LIMIT_FILE_SIZE";
    response.status(tooLarge ? 413 : 400).json({
      success: false,
      data: null,
      message: tooLarge ? "Image must be 5 MB or smaller" : "Choose one valid image file",
      error: { code: tooLarge ? "IMAGE_TOO_LARGE" : "INVALID_IMAGE_UPLOAD" },
    });
    return;
  }

  if (error?.name === "ValidationError") {
    response.status(400).json({
      success: false,
      data: null,
      message: "Request validation failed",
      error: { code: "VALIDATION_ERROR" },
    });
    return;
  }

  if (error.type === "entity.parse.failed") {
    response.status(400).json({
      success: false,
      data: null,
      message: "Request body must contain valid JSON",
      error: { code: "INVALID_JSON" },
    });
    return;
  }

  if (error.type === "entity.too.large") {
    response.status(413).json({
      success: false,
      data: null,
      message: "Request body is too large",
      error: { code: "PAYLOAD_TOO_LARGE" },
    });
    return;
  }

  console.error("Unhandled request error", error);
  response.status(500).json({
    success: false,
    data: null,
    message: "An unexpected error occurred",
    error: { code: "INTERNAL_SERVER_ERROR" },
  });
}
