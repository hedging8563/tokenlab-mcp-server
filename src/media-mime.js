const GENERIC_BINARY_MIME_TYPES = new Set([
  "application/octet-stream",
  "binary/octet-stream"
]);

function base64Prefix(value, maxCharacters = 64) {
  let prefix = "";
  for (let index = 0; index < value.length && prefix.length < maxCharacters; index += 1) {
    const character = value[index];
    if (/\s/.test(character)) continue;
    if (!/[A-Za-z0-9+/=]/.test(character)) return null;
    prefix += character;
  }
  return prefix || null;
}

export function sniffBase64ImageMimeType(data) {
  const prefix = base64Prefix(data);
  if (!prefix) return null;
  const bytes = Buffer.from(prefix, "base64");
  if (
    bytes.length >= 8
    && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12
    && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) return "image/webp";
  if (bytes.length >= 6) {
    const signature = bytes.subarray(0, 6).toString("ascii");
    if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
  }
  return null;
}

/**
 * Correct only generic binary image data URLs whose bytes prove a supported image type.
 * Other values are returned unchanged so protocol-specific policy remains explicit.
 */
export function normalizeGenericBinaryImageDataUrl(value) {
  if (typeof value !== "string" || value.slice(0, 5).toLowerCase() !== "data:") {
    return { status: "unchanged", value };
  }
  const commaIndex = value.indexOf(",");
  if (commaIndex < 0) return { status: "unchanged", value };

  const metadata = value.slice(5, commaIndex).split(";");
  const mimeType = metadata[0]?.trim().toLowerCase();
  if (metadata.at(-1)?.trim().toLowerCase() !== "base64" || !GENERIC_BINARY_MIME_TYPES.has(mimeType)) {
    return { status: "unchanged", value };
  }

  const payload = value.slice(commaIndex + 1);
  const detectedMimeType = sniffBase64ImageMimeType(payload);
  if (!detectedMimeType) {
    return { status: "unrecognized", value, declaredMimeType: mimeType };
  }
  return {
    status: "normalized",
    value: `data:${detectedMimeType};base64,${payload}`,
    declaredMimeType: mimeType,
    detectedMimeType
  };
}
