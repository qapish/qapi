// packages/scale/src/metadata.ts
// Hardened V14/V15/V16 metadata reader: extracts pallet { name, index, calls[], events[] }.
// Tolerant (per-pallet try/catch); robust skipping to avoid misalignment.
// NodeNext-safe: relative imports use .js
import { hexToU8a } from "./index.js";

const META_MAGIC = [0x6d, 0x65, 0x74, 0x61];

export type MetaTables = {
  version: 14 | 15 | 16;
  pallets: Array<{
    name: string;
    index: number; // u8 "pallet index" used in call/event indices
    calls?: string[]; // call names in index order
    events?: string[]; // event names in index order
  }>;
};

// helper: hex preview
function preview(u8: Uint8Array, n = 24): string {
  const len = Math.min(n, u8.length);
  let s = "";
  for (let i = 0; i < len; i++) s += u8[i]!.toString(16).padStart(2, "0");
  return "0x" + s;
}

// unwrap strategies
function tryUnwrapVecU8(raw: Uint8Array): Uint8Array | null {
  try {
    let off = 0;
    const b0 = raw[off++]!;
    const mode = b0 & 0b11;
    let L = -1;
    if (mode === 0) L = b0 >> 2;
    else if (mode === 1) {
      const b1 = raw[off++]!;
      L = ((b0 >> 2) | (b1 << 6)) >>> 0;
    } else if (mode === 2) {
      const b1 = raw[off++]!,
        b2 = raw[off++]!,
        b3 = raw[off++]!;
      L = ((b0 >> 2) | (b1 << 6) | (b2 << 14) | (b3 << 22)) >>> 0;
    } else {
      return null;
    } // big-int mode, unlikely for metadata bytes wrapper
    if (off + L === raw.length) return raw.subarray(off, off + L);
    return null;
  } catch {
    return null;
  }
}

function stripMetaMagic(u8: Uint8Array): Uint8Array {
  if (
    u8.length >= 5 &&
    u8[0] === META_MAGIC[0] &&
    u8[1] === META_MAGIC[1] &&
    u8[2] === META_MAGIC[2] &&
    u8[3] === META_MAGIC[3]
  ) {
    return u8.subarray(4);
  }
  return u8;
}

// ----------------- tiny reader -----------------
class Reader {
  o = 0;
  constructor(public u8: Uint8Array) {}
  get offset() {
    return this.o;
  }
  eof() {
    return this.o >= this.u8.length;
  }
  u8_(): number {
    if (this.o >= this.u8.length) throw new Error("read u8 OOB");
    return this.u8[this.o++]!;
  }
  bytes(n: number): Uint8Array {
    if (this.o + n > this.u8.length) throw new Error("read bytes OOB");
    const out = this.u8.subarray(this.o, this.o + n);
    this.o += n;
    return out;
  }
  compactU32(): number {
    const b0 = this.u8_();
    const m = b0 & 0b11;
    if (m === 0) return b0 >> 2;
    if (m === 1) {
      const b1 = this.u8_();
      return ((b0 >> 2) | (b1 << 6)) >>> 0;
    }
    if (m === 2) {
      const b1 = this.u8_(),
        b2 = this.u8_(),
        b3 = this.u8_();
      return ((b0 >> 2) | (b1 << 6) | (b2 << 14) | (b3 << 22)) >>> 0;
    }
    throw new Error("big-int compact not implemented");
  }
  text(): string {
    const len = this.compactU32();
    const b = this.bytes(len);
    return new TextDecoder().decode(b);
  }
  vec<T>(elem: () => T): T[] {
    const len = this.compactU32();
    const out = new Array<T>(len);
    for (let i = 0; i < len; i++) out[i] = elem();
    return out;
  }
  option<T>(elem: () => T): T | undefined {
    const tag = this.u8_();
    if (tag === 0) return undefined;
    if (tag === 1) return elem();
    throw new Error("Option tag invalid");
  }
  // tolerant skipping
  skipVec(elem: () => void) {
    const len = this.compactU32();
    for (let i = 0; i < len; i++) elem();
  }
  skipTextVec() {
    this.skipVec(() => {
      this.text();
    });
  }
  skipBytes() {
    const n = this.compactU32();
    this.bytes(n);
  } // SCALE Bytes = Vec<u8>
}

// ----------------- portable registry (only what we need) -----------------
type TypeDef = {
  kind: "Variant" | "Other";
  variants?: { name: string; index: number }[];
};

function readPortableType(r: Reader): { id: number; def: TypeDef } {
  const id = r.compactU32();

  // path: Vec<Text>
  r.skipTextVec();

  // parameters: Vec<TypeParameter>
  // TypeParameter { name: Text, type: Option<Compact<u32>>, typeName: Option<Text> }
  r.skipVec(() => {
    r.text(); // name
    r.option(() => r.compactU32()); // type
    r.option(() => r.text()); // typeName
  });

  // TypeDefDef tag
  const tag = r.u8_();
  let def: TypeDef = { kind: "Other" };

  if (tag === 1 /* Variant */) {
    const variants = r.vec(() => {
      const vName = r.text();
      // fields: Vec<Field> (skip)
      r.skipVec(() => {
        r.option(() => r.text()); // Field.name
        r.compactU32(); // Field.type (id)
        r.option(() => r.text()); // Field.typeName
        r.skipTextVec(); // Field.docs
      });
      const index = r.u8_();
      r.skipTextVec(); // Variant.docs
      return { name: vName, index };
    });
    def = { kind: "Variant", variants };
  } else {
    // best-effort skip payload by kind tag
    switch (tag) {
      case 0: {
        // Composite { fields: Vec<Field> }
        r.skipVec(() => {
          r.option(() => r.text());
          r.compactU32();
          r.option(() => r.text());
          r.skipTextVec();
        });
        break;
      }
      case 2: {
        /* Sequence { type } */ r.compactU32();
        break;
      }
      case 3: {
        /* Array { len, type } */ r.compactU32();
        r.compactU32();
        break;
      }
      case 4: {
        /* Tuple Vec<type> */ r.skipVec(() => {
          r.compactU32();
        });
        break;
      }
      case 5: {
        /* Primitive tag */ r.u8_();
        break;
      }
      case 6: {
        /* Compact { type } */ r.compactU32();
        break;
      }
      case 7: {
        /* BitSequence { bitStoreType, bitOrderType } */ r.compactU32();
        r.compactU32();
        break;
      }
      case 8: {
        /* HistoricMetaCompat */ break;
      }
      default:
        break;
    }
  }

  // docs: Vec<Text>
  r.skipTextVec();

  return { id, def };
}

function readPortableRegistry(r: Reader): Map<number, TypeDef> {
  const types = r.vec(() => readPortableType(r));
  const m = new Map<number, TypeDef>();
  for (const t of types) m.set(t.id, t.def);
  return m;
}

function readVariantNames(
  registry: Map<number, TypeDef>,
  typeId: number | undefined,
): string[] | undefined {
  if (typeId === undefined) return undefined;
  const def = registry.get(typeId);
  if (def?.kind !== "Variant" || !def.variants) return undefined;
  const ordered = [...def.variants].sort((a, b) => a.index - b.index);
  return ordered.map((v) => v.name);
}

// ---------- tolerant pallet parser ----------
function readOnePallet(r: Reader, registry: Map<number, TypeDef>) {
  const name = r.text();

  // storage: Option<StorageMetadata> — skip tolerantly
  try {
    r.option(() => {
      r.text(); // prefix
      r.skipVec(() => {
        r.text(); // entry name
        r.u8_(); // modifier
        const tyTag = r.u8_(); // entry type
        if (tyTag === 0) {
          r.compactU32(); // Plain { type }
        } else if (tyTag === 1) {
          // Map { hashers: Vec<StorageHasher>, key: Type, value: Type }
          r.skipVec(() => {
            r.u8_();
          }); // hashers (enum tags)
          r.compactU32(); // key
          r.compactU32(); // value
        }
        r.skipBytes(); // fallback (Bytes)
        r.skipTextVec(); // docs
      });
      r.u8_(); // cache bool / isFallbackEvicted
      return 0;
    });
  } catch {
    /* tolerate */
  }

  // calls/events: Option<Compact<u32>>
  let callsTy: number | undefined;
  let eventsTy: number | undefined;
  try {
    callsTy = r.option(() => r.compactU32());
  } catch {}
  try {
    eventsTy = r.option(() => r.compactU32());
  } catch {}

  // constants: Vec<Constant> — skip tolerantly
  try {
    r.skipVec(() => {
      r.text(); // name
      r.compactU32(); // type
      r.skipBytes(); // value
      r.skipTextVec(); // docs
    });
  } catch {
    /* tolerate */
  }

  // errors: V14 Option<Type>  OR  V15 Vec<ErrorMetadata>
  try {
    const tagOrLen = r.u8_();
    if (tagOrLen === 0 || tagOrLen === 1) {
      if (tagOrLen === 1) r.compactU32(); // type id
    } else {
      // treat as Vec<ErrorMetadata>
      r.o -= 1;
      r.skipVec(() => {
        r.text();
        r.skipTextVec();
      }); // name + docs
    }
  } catch {
    /* tolerate */
  }

  // index: u8 (critical)
  let index = 255;
  try {
    index = r.u8_();
  } catch {
    index = 255;
  }

  // optional trailing docs in some metas
  try {
    r.skipTextVec();
  } catch {}

  const calls = readVariantNames(registry, callsTy);
  const events = readVariantNames(registry, eventsTy);

  return { name, index, calls, events };
}

function readPalletsV14orV16(r: Reader, registry: Map<number, TypeDef>) {
  const len = r.compactU32();
  const pallets: MetaTables["pallets"] = new Array(len);
  for (let i = 0; i < len; i++) {
    try {
      pallets[i] = readOnePallet(r, registry);
    } catch {
      pallets[i] = { name: `pallet_${i}`, index: 255 };
    }
  }
  return pallets;
}

// ----------------- entry point -----------------
export function extractMetaTables(
  metaHexOrBytes: string | Uint8Array,
): MetaTables {
  const raw =
    typeof metaHexOrBytes === "string"
      ? hexToU8a(metaHexOrBytes)
      : metaHexOrBytes;

  // 1) Try raw as-is + strip "meta"
  const as1 = stripMetaMagic(raw);
  // 2) Try unwrap Vec<u8> then strip "meta"
  const maybeVec = tryUnwrapVecU8(raw);
  const as2 = maybeVec ? stripMetaMagic(maybeVec) : null;

  // choose candidate: prefer the one that looks like a versioned metadata (tag in first byte)
  const candidates: Array<{ src: string; bytes: Uint8Array }> = [];
  candidates.push({ src: maybeVec ? "vec+meta" : "raw+meta", bytes: as1 });
  if (as2) candidates.push({ src: "unwrapped+meta", bytes: as2 });

  let lastErr: unknown = undefined;

  for (const cand of candidates) {
    try {
      const r = new Reader(cand.bytes);
      const tag = r.u8_(); // version after "meta"
      if (tag !== 14 && tag !== 15 && tag !== 16) {
        throw new Error(
          `bad version tag ${tag} (first bytes ${preview(cand.bytes)}) [${cand.src}]`,
        );
      }
      const version = tag as 14 | 15 | 16;

      const registry = readPortableRegistry(r);
      const pallets = readPalletsV14orV16(r, registry);

      // optional debug (enabled if env set)
      if (process.env.QAPI_DEBUG) {
        // eslint-disable-next-line no-console
        console.log(
          `extractMetaTables: ok version=${version} pallets=${pallets.length} src=${cand.src} head=${preview(cand.bytes)}`,
        );
      }
      return { version, pallets };
    } catch (e) {
      lastErr = e;
      if (process.env.QAPI_DEBUG) {
        // eslint-disable-next-line no-console
        console.error(
          `extractMetaTables: candidate failed (${cand.src}) head=${preview(cand.bytes)} err=`,
          e,
        );
      }
    }
  }

  // if both candidates fail, throw the last error (substrate will catch and fallback)
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
