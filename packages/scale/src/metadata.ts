// packages/scale/src/metadata.ts
// Dependency-free Metadata V14/V15/V16 reader that extracts:
//   { version, pallets: [{ name, index, calls?: string[], events?: string[] }] }
//
// Notes (important for alignment):
// - SCALE enum discriminants in scale-info Metadata are encoded as u8 (NOT compact),
//   unless the field itself is declared as a Compact<T>. We only use compact for fields
//   explicitly defined as Compact<u32> (type ids, lengths, etc).
// - TypeParameter has: name: Text, type: Option<Compact<u32>>, typeName: Option<Text>
// - Variant.index is u8
// - Storage entry kind discriminant is u8; StorageHasher discriminants are u8.
//
// NodeNext-safe local import:
import { hexToU8a } from "./index.js";

export type MetaTables = {
  version: 14 | 15 | 16;
  pallets: Array<{
    name: string;
    index: number; // u8 pallet index used in call/event indices
    calls?: string[]; // call variant names by variant.index
    events?: string[]; // event variant names by variant.index
  }>;
};

// --------------------------------- Reader ---------------------------------
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
  u32_(): number {
    // little-endian u32
    const a = this.u8_(),
      b = this.u8_(),
      c = this.u8_(),
      d = this.u8_();
    return (a | (b << 8) | (c << 16) | (d << 24)) >>> 0;
  }
  bytes(n: number): Uint8Array {
    if (this.o + n > this.u8.length) throw new Error("read bytes OOB");
    const out = this.u8.subarray(this.o, this.o + n);
    this.o += n;
    return out;
  }
  compactU32(): number {
    const b0 = this.u8_();
    const mode = b0 & 0b11;
    if (mode === 0) return b0 >>> 2;
    if (mode === 1) {
      const b1 = this.u8_();
      return ((b0 >>> 2) | (b1 << 6)) >>> 0;
    }
    if (mode === 2) {
      const b1 = this.u8_(),
        b2 = this.u8_(),
        b3 = this.u8_();
      return ((b0 >>> 2) | (b1 << 6) | (b2 << 14) | (b3 << 22)) >>> 0;
    }
    // mode === 3 (big int): len = (b0 >> 2) + 4, next len bytes little-endian
    const len = (b0 >>> 2) + 4;
    let val = 0;
    for (let i = 0; i < len; i++) val += this.u8_() * 2 ** (8 * i);
    return val >>> 0;
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
  // helpers
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

// ----------------------- Portable Registry (Si1) --------------------------
type TypeDef = {
  kind: "Variant" | "Other";
  variants?: { name: string; index: number }[];
};

// Field: name: Option<Text>, type: Compact<u32>, typeName: Option<Text>, docs: Vec<Text>
function skipSiField(r: Reader) {
  r.option(() => r.text()); // name
  r.compactU32(); // type id
  r.option(() => r.text()); // typeName
  r.skipTextVec(); // docs
}

// TypeParameter: name: Text, type: Option<Compact<u32>>, typeName: Option<Text>
function skipSiTypeParameter(r: Reader) {
  r.text();
  r.option(() => r.compactU32());
  r.option(() => r.text());
}

function readSiTypeDef(r: Reader): TypeDef {
  // IMPORTANT: TypeDef discriminant is a u8
  const tag = r.u8_();
  switch (tag) {
    case 1: {
      // Variant { variants: Vec<SiVariant> }
      const variants = r.vec(() => {
        const vName = r.text();
        r.skipVec(() => skipSiField(r)); // fields
        const index = r.u8_(); // u8 index
        r.skipTextVec(); // docs
        return { name: vName, index };
      });
      return { kind: "Variant", variants };
    }
    case 0: {
      // Composite { fields: Vec<SiField> }
      r.skipVec(() => skipSiField(r));
      return { kind: "Other" };
    }
    case 2: {
      // Sequence { type }
      r.compactU32();
      return { kind: "Other" };
    }
    case 3: {
      // Array { len: u32, type }
      r.u32_();
      r.compactU32();
      return { kind: "Other" };
    }
    case 4: {
      // Tuple(Vec<type>)
      r.skipVec(() => {
        r.compactU32();
      });
      return { kind: "Other" };
    }
    case 5: {
      // Primitive { kind: PrimitiveType }  // primitive kind = u8
      r.u8_();
      return { kind: "Other" };
    }
    case 6: {
      // Compact { type }
      r.compactU32();
      return { kind: "Other" };
    }
    case 7: {
      // BitSequence { bitStoreType, bitOrderType }
      r.compactU32();
      r.compactU32();
      return { kind: "Other" };
    }
    case 8: {
      // HistoricMetaCompat
      return { kind: "Other" };
    }
    default:
      return { kind: "Other" };
  }
}

function readPortableType(r: Reader): { id: number; def: TypeDef } {
  const id = r.compactU32();

  // path: Vec<Text>
  r.skipTextVec();

  // parameters: Vec<TypeParameter>
  r.skipVec(() => skipSiTypeParameter(r));

  // type definition:
  const def = readSiTypeDef(r);

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

function variantNamesFrom(
  reg: Map<number, TypeDef>,
  typeId?: number,
): string[] | undefined {
  if (typeId === undefined) return undefined;
  const def = reg.get(typeId);
  if (def?.kind !== "Variant" || !def.variants) return undefined;
  const ordered = [...def.variants].sort((a, b) => a.index - b.index);
  return ordered.map((v) => v.name);
}

// --------------------------- Pallets (V14–V16) ----------------------------
function readOnePallet(r: Reader, reg: Map<number, TypeDef>) {
  const name = r.text();

  // storage: Option<StorageMetadata>
  try {
    r.option(() => {
      r.text(); // prefix
      // items: Vec<StorageEntryMetadata>
      r.skipVec(() => {
        r.text(); // entry name
        r.u8_(); // modifier (enum u8)
        const entryKind = r.u8_(); // Plain=0, Map=1 (enum u8)
        if (entryKind === 0) {
          r.compactU32(); // Plain { type }
        } else if (entryKind === 1) {
          // Map { hashers, key, value }
          r.skipVec(() => {
            r.u8_();
          }); // hashers: Vec<Hasher enum u8>
          r.compactU32(); // key type id
          r.compactU32(); // value type id
        }
        r.skipBytes(); // fallback Bytes
        r.skipTextVec(); // docs
      });
      r.u8_(); // isFallbackEvicted/cache flag
      return 0;
    });
  } catch {
    /* tolerate */
  }

  // calls: Option<Compact<u32>>; events: Option<Compact<u32>>
  let callsTy: number | undefined;
  let eventsTy: number | undefined;
  try {
    callsTy = r.option(() => r.compactU32());
  } catch {}
  try {
    eventsTy = r.option(() => r.compactU32());
  } catch {}

  // constants: Vec<ConstantMetadata>
  try {
    r.skipVec(() => {
      r.text(); // name
      r.compactU32(); // type
      r.skipBytes(); // value
      r.skipTextVec(); // docs
    });
  } catch {}

  // errors: V14 Option<Type>; V15+ Vec<ErrorMetadata>
  try {
    const b = r.u8_();
    if (b === 0 || b === 1) {
      if (b === 1) r.compactU32(); // type id
    } else {
      r.o -= 1; // rewind and read as Vec<ErrorMetadata>
      r.skipVec(() => {
        r.text();
        r.skipTextVec();
      }); // name + docs
    }
  } catch {
    /* tolerate */
  }

  // index: u8
  let index = 255;
  try {
    index = r.u8_();
  } catch {}

  // optional trailing docs (some metas)
  try {
    r.skipTextVec();
  } catch {}

  const calls = variantNamesFrom(reg, callsTy);
  const events = variantNamesFrom(reg, eventsTy);

  return { name, index, calls, events };
}

function readPallets(r: Reader, reg: Map<number, TypeDef>) {
  const len = r.compactU32();
  const out: MetaTables["pallets"] = new Array(len);
  for (let i = 0; i < len; i++) {
    try {
      out[i] = readOnePallet(r, reg);
    } catch {
      out[i] = { name: `pallet_${i}`, index: 255 };
    }
  }
  return out;
}

// ------------------------------ Entry point -------------------------------
const META_MAGIC = [0x6d, 0x65, 0x74, 0x61]; // "meta"

function tryUnwrapVecU8(raw: Uint8Array): Uint8Array | null {
  try {
    let off = 0;
    const b0 = raw[off++]!;
    const mode = b0 & 0b11;
    let L = -1;
    if (mode === 0) L = b0 >>> 2;
    else if (mode === 1) {
      const b1 = raw[off++]!;
      L = ((b0 >>> 2) | (b1 << 6)) >>> 0;
    } else if (mode === 2) {
      const b1 = raw[off++]!,
        b2 = raw[off++]!,
        b3 = raw[off++]!;
      L = ((b0 >>> 2) | (b1 << 6) | (b2 << 14) | (b3 << 22)) >>> 0;
    } else return null; // big-int unlikely for metadata Vec wrapper
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

export function extractMetaTables(
  metaHexOrBytes: string | Uint8Array,
): MetaTables {
  const raw =
    typeof metaHexOrBytes === "string"
      ? hexToU8a(metaHexOrBytes)
      : metaHexOrBytes;

  // Candidates: (raw stripped), (vec-unwrapped then stripped)
  const c1 = stripMetaMagic(raw);
  const maybeVec = tryUnwrapVecU8(raw);
  const c2 = maybeVec ? stripMetaMagic(maybeVec) : null;

  const candidates: Uint8Array[] = [c1, ...(c2 ? [c2] : [])];
  let lastErr: unknown;

  for (const cand of candidates) {
    try {
      const r = new Reader(cand);
      const ver = r.u8_();
      if (ver !== 14 && ver !== 15 && ver !== 16)
        throw new Error(`bad version tag ${ver}`);
      const version = ver as 14 | 15 | 16;

      const registry = readPortableRegistry(r);
      const pallets = readPallets(r, registry);

      return { version, pallets };
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
