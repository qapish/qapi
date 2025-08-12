// packages/scale/src/index.ts
import { blake2b } from "@noble/hashes/blake2";

export type Bytes = Uint8Array;

// ---------- tiny asserts ----------
function expect(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// ---------- Hex utils ----------
export function hexToU8a(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  expect(h.length % 2 === 0, "hexToU8a: hex length must be even");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
export function u8aToHex(u8: Uint8Array): string {
  let s = "0x";
  for (let i = 0; i < u8.length; i++) {
    const b = u8[i]!; // assert: within bounds of the for-loop
    s += b.toString(16).padStart(2, "0");
  }
  return s;
}

// ---------- SCALE primitives ----------
/** Compact<u32> encode (modes 0/1/2; big-int mode not implemented) */
export function encodeCompactU32(value: number): Uint8Array {
  if (value < 0) throw new Error("compact: negative");
  if (value < 1 << 6) return new Uint8Array([(value << 2) | 0b00]);
  if (value < 1 << 14) {
    const v = (value << 2) | 0b01;
    return new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
  }
  if (value < 1 << 30) {
    const v = (value << 2) | 0b10;
    return new Uint8Array([
      v & 0xff,
      (v >> 8) & 0xff,
      (v >> 16) & 0xff,
      (v >> 24) & 0xff,
    ]);
  }
  throw new Error("compact: big-integer mode not implemented");
}

/** Minimal compact<u32> decode to pair with the prefix reader */
export function decodeCompactU32(
  bytes: Uint8Array,
  offset = 0,
): [number, number] {
  expect(offset >= 0 && offset < bytes.length, "compact decode: out of range");
  const first = bytes[offset]!;
  const mode = first & 0b11;

  if (mode === 0) return [first >> 2, 1];

  if (mode === 1) {
    expect(offset + 1 < bytes.length, "compact decode: need 2 bytes");
    const v = ((first >> 2) | (bytes[offset + 1]! << 6)) >>> 0;
    return [v, 2];
  }

  if (mode === 2) {
    expect(offset + 3 < bytes.length, "compact decode: need 4 bytes");
    const v =
      (first >> 2) |
      (bytes[offset + 1]! << 6) |
      (bytes[offset + 2]! << 14) |
      (bytes[offset + 3]! << 22);
    return [v >>> 0, 4];
  }

  throw new Error("compact: big-integer mode not implemented");
}

export function concatU8a(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** SCALE Vec<Bytes> where each element is already SCALE-encoded DigestItem bytes */
export function encodeVecOfBytes(items: Uint8Array[]): Uint8Array {
  return concatU8a(encodeCompactU32(items.length), ...items);
}

// ---------- Header encoding & hashing ----------
/**
 * Encode a Substrate header from the node's JSON into SCALE:
 * Header = { parentHash: H256, number: Compact<u32>, stateRoot: H256, extrinsicsRoot: H256, digest: Digest }
 * Digest = Vec<DigestItem>; RPC gives logs as SCALE-encoded DigestItem bytes (hex) — we just wrap them as Vec<>.
 */
export function encodeHeaderFromJson(header: {
  parentHash: string;
  number: string | number;
  stateRoot: string;
  extrinsicsRoot: string;
  digest: { logs: string[] } | undefined;
}): Uint8Array {
  expect(
    typeof header.parentHash === "string",
    "header.parentHash must be hex",
  );
  expect(typeof header.stateRoot === "string", "header.stateRoot must be hex");
  expect(
    typeof header.extrinsicsRoot === "string",
    "header.extrinsicsRoot must be hex",
  );

  const parent = hexToU8a(header.parentHash);
  const number =
    typeof header.number === "number"
      ? header.number
      : parseInt(String(header.number), 16);
  expect(Number.isFinite(number) && number >= 0, "header.number invalid");
  const numberEnc = encodeCompactU32(number);

  const state = hexToU8a(header.stateRoot);
  const extrinsicsRoot = hexToU8a(header.extrinsicsRoot);
  const logsHex = header.digest?.logs ?? [];
  const logs = logsHex.map(hexToU8a);
  const digestEnc = encodeVecOfBytes(logs);

  return concatU8a(parent, numberEnc, state, extrinsicsRoot, digestEnc);
}

/** BlakeTwo256 = Blake2b-256 */
export function blakeTwo256(data: Uint8Array): Uint8Array {
  return blake2b(data, { dkLen: 32 });
}

/** Compute header hash (H256 hex) */
export function headerHash(headerJson: unknown): string {
  const enc = encodeHeaderFromJson(headerJson as any);
  return u8aToHex(blakeTwo256(enc));
}

// ---------- Extrinsic pre-decode (prep for metadata-driven decoding) ----------
/** Reads SCALE compact length + version byte; returns { len, version, isSigned, offsetAfterVersion } */
export function readExtrinsicPrefix(u8: Uint8Array): {
  len: number;
  version: number;
  isSigned: boolean;
  offset: number;
} {
  const [len, lenBytes] = decodeCompactU32(u8, 0);
  expect(lenBytes < u8.length, "extrinsic prefix: missing version byte");
  const version = u8[lenBytes]!;
  const isSigned = (version & 0x80) === 0x80; // bit 7
  return { len, version, isSigned, offset: lenBytes + 1 };
}
