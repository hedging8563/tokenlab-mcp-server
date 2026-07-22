import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeGenericBinaryImageDataUrl,
  sniffBase64ImageMimeType
} from "../src/media-mime.js";

test("detects supported image signatures from a bounded base64 prefix", () => {
  const cases = [
    ["image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ["image/jpeg", Buffer.from([0xff, 0xd8, 0xff])],
    ["image/webp", Buffer.from("RIFF0000WEBP", "ascii")],
    ["image/gif", Buffer.from("GIF89a", "ascii")]
  ];
  for (const [mimeType, bytes] of cases) {
    assert.equal(sniffBase64ImageMimeType(bytes.toString("base64")), mimeType);
  }
});

test("normalizes only byte-provable generic binary image data URLs", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");
  assert.deepEqual(normalizeGenericBinaryImageDataUrl(`data:application/octet-stream;base64,${png}`), {
    status: "normalized",
    value: `data:image/png;base64,${png}`,
    declaredMimeType: "application/octet-stream",
    detectedMimeType: "image/png"
  });
  assert.deepEqual(normalizeGenericBinaryImageDataUrl(`data:image/png;base64,${png}`), {
    status: "unchanged",
    value: `data:image/png;base64,${png}`
  });
  assert.equal(normalizeGenericBinaryImageDataUrl("https://example.com/image.png").status, "unchanged");
  assert.equal(
    normalizeGenericBinaryImageDataUrl(`data:application/octet-stream;base64,${Buffer.from("not an image").toString("base64")}`).status,
    "unrecognized"
  );
});
