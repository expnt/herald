import { Buffer } from "node-buffer";
import { createHash } from "node-crypto";

// CRC32 implementation for Deno/Node
// S3 uses a specific CRC32 (IEEE 802.3)
const CRC32_TABLE = new Int32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC32_TABLE[i] = c;
}

function crc32(data: Uint8Array, previous = 0) {
  let crc = previous ^ -1;
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ data[i]) & 0xFF];
  }
  return (crc ^ -1) >>> 0;
}

// CRC32C (Castagnoli)
const CRC32C_TABLE = new Int32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = (c & 1) ? (0x82F63B78 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC32C_TABLE[i] = c;
}

function crc32c(data: Uint8Array, previous = 0) {
  let crc = previous ^ -1;
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ CRC32C_TABLE[(crc ^ data[i]) & 0xFF];
  }
  return (crc ^ -1) >>> 0;
}

async function test() {
  const data = new TextEncoder().encode("hello world");

  // SHA256
  const sha256 = createHash("sha256").update(data).digest("base64");
  console.log("SHA256:", sha256);

  // SHA1
  const sha1 = createHash("sha1").update(data).digest("base64");
  console.log("SHA1:", sha1);

  // CRC32
  const c32 = crc32(data);
  const c32Base64 = Buffer.from(new Uint32Array([c32]).buffer).reverse()
    .toString("base64");
  // Wait, S3 CRC32 is big-endian 4 bytes base64 encoded
  const c32Buf = Buffer.alloc(4);
  c32Buf.writeUInt32BE(c32);
  console.log("CRC32:", c32Buf.toString("base64"));

  // CRC32C
  const c32c = crc32c(data);
  const c32cBuf = Buffer.alloc(4);
  c32cBuf.writeUInt32BE(c32c);
  console.log("CRC32C:", c32cBuf.toString("base64"));
}

test();
