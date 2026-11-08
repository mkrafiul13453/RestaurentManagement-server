import { AppError } from "../utils/app-error.js";
import sharp from "sharp";

const imageSignatures = {
  "image/jpeg": (buffer) => buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff,
  "image/png": (buffer) => buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  "image/webp": (buffer) =>
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP",
  "image/avif": (buffer) => {
    if (buffer.length < 16 || buffer.toString("ascii", 4, 8) !== "ftyp") return false;
    const brands = [buffer.toString("ascii", 8, 12)];
    for (let offset = 16; offset + 4 <= buffer.length; offset += 4) {
      brands.push(buffer.toString("ascii", offset, offset + 4));
    }
    return brands.some((brand) => brand === "avif" || brand === "avis");
  },
};

export function createImageUploadService({ apiKey, fetchImpl = fetch }) {
  return {
    async upload(file) {
      if (!apiKey) {
        throw new AppError("Image uploads are not configured on the server", 503, "IMAGE_UPLOAD_NOT_CONFIGURED");
      }
      if (!file || !imageSignatures[file.mimetype]?.(file.buffer)) {
        throw new AppError("Choose a valid JPEG, PNG, WebP, or AVIF image", 400, "INVALID_IMAGE");
      }

      let imageBuffer = file.buffer;
      let imageName = safeImageName(file.originalname);
      if (file.mimetype === "image/avif") {
        try {
          imageBuffer = await sharp(file.buffer).jpeg().toBuffer();
        } catch {
          throw new AppError("The AVIF image could not be decoded", 400, "INVALID_IMAGE");
        }
        imageName = `${imageName.replace(/\.avif$/i, "")}.jpg`;
      }

      const body = new URLSearchParams({
        image: imageBuffer.toString("base64"),
        name: imageName,
      });
      const endpoint = new URL("https://api.imgbb.com/1/upload");
      endpoint.searchParams.set("key", apiKey);

      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
          signal: AbortSignal.timeout(15000),
        });
      } catch {
        throw new AppError("ImgBB could not be reached. Please try again.", 502, "IMAGE_HOST_UNAVAILABLE");
      }

      let result;
      try {
        result = await response.json();
      } catch {
        throw new AppError("ImgBB returned an invalid response", 502, "IMAGE_HOST_ERROR");
      }
      const imageUrl = result?.data?.url;
      if (!response.ok || result?.success !== true || !isImgBbUrl(imageUrl)) {
        throw new AppError("ImgBB could not upload this image", 502, "IMAGE_HOST_ERROR");
      }
      return imageUrl;
    },
  };
}

export function isImgBbUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "i.ibb.co" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function safeImageName(value) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "menu-item";
}
