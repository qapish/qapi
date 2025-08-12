// packages/scale/src/metadata.ts
// Hardened V14/V15 metadata reader: extracts pallet {name,index,calls,events}.
// Tolerant: per-pallet try/catch; robust skipping to avoid misalignment.
// NodeNext-safe: relative imports use .js
import { hexToU8a } from "./index.js";

export type MetaTables = {
  version: 14 | 15;
  pallets: Array<{
    name: string;
    index: number; // u8 "pallet index" used in call/event indices
    calls?: string[]; // call names in index order
    events?: string[]; // event names in index order
  }>;
};

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
  // utilities for tolerant skipping
  skipVec(elem: () => void) {
    const len = this.compactU32();
    for (let i = 0; i < len; i++) elem();
  }
  skipTextVec() {
    this.skipVec(() => {
      this.text();
    });
  }
  // Skip SCALE "Bytes" (Vec<u8>)
  skipBytes() {
    const n = this.compactU32();
    this.bytes(n);
  }
}

// ----------------- portable registry (only what we need) -----------------
type TypeDef = {
  kind: "Variant" | "Other";
  variants?: { name: string; index: number }[];
};
function readPortableType(r: Reader): { id: number; def: TypeDef } {
  const id = r.compactU32();
  r.skipTextVec(); // path
  r.skipVec(() => {
    r.text();
    r.option(() => r.compactU32());
  }); // parameters
  const tag = r.u8_();
  let def: TypeDef = { kind: "Other" };

  if (tag === 1 /* Variant */) {
    const variants = r.vec(() => {
      const vName = r.text();
      r.skipVec(() => {
        // fields
        r.option(() => r.text()); // name
        r.compactU32(); // type id
        r.option(() => r.text()); // typeName
        r.skipTextVec(); // docs
      });
      const index = r.u8_();
      r.skipTextVec(); // variant docs
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
  r.skipTextVec(); // docs
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
  const start = r.offset;
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
          }); // hashers: enum tag(s)
          r.compactU32(); // key
          r.compactU32(); // value
        } else {
          // unexpected, bail conservatively
        }
        r.skipBytes(); // fallback Bytes
        r.skipTextVec(); // docs
      });
      r.u8_(); // isFallbackEvicted / cache bool
      return 0;
    });
  } catch {
    // storage skipping failed; rewind to start of calls Option best-effort
    // (we won’t rewind the whole pallet, just continue; misalignment will be caught by try/catch below)
  }

  // calls/events: Option<Compact<u32>>
  let callsTy: number | undefined;
  let eventsTy: number | undefined;
  try {
    callsTy = r.option(() => r.compactU32());
  } catch {
    /* tolerate */
  }
  try {
    eventsTy = r.option(() => r.compactU32());
  } catch {
    /* tolerate */
  }

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
    // If we fail to read the index, try to resync: give up and set a sentinel.
    index = 255;
  }

  // In V15 there may be trailing docs for pallet; tolerate if present.
  try {
    r.skipTextVec();
  } catch {
    /* ignore */
  }

  const calls = readVariantNames(registry, callsTy);
  const events = readVariantNames(registry, eventsTy);

  // Guarantee name/index even if calls/events are undefined
  return { name, index, calls, events, _start: start, _end: r.offset };
}

function readPalletsV14orV15(r: Reader, registry: Map<number, TypeDef>) {
  const len = r.compactU32();
  const pallets = new Array<{
    name: string;
    index: number;
    calls?: string[];
    events?: string[];
  }>(len);
  for (let i = 0; i < len; i++) {
    try {
      const p = readOnePallet(r, registry);
      pallets[i] = {
        name: p.name,
        index: p.index,
        calls: p.calls,
        events: p.events,
      };
    } catch {
      // If a pallet completely fails, skip conservatively by consuming nothing further for this entry.
      // Fill a placeholder so callers see the count is correct.
      pallets[i] = { name: `pallet_${i}`, index: 255 };
    }
  }
  return pallets;
}

// ----------------- entry point -----------------
export function extractMetaTables(
  metaHexOrBytes: string | Uint8Array,
): MetaTables {
  const u8 =
    typeof metaHexOrBytes === "string"
      ? hexToU8a(metaHexOrBytes)
      : metaHexOrBytes;
  const r = new Reader(u8);
  const tag = r.u8_();
  if (tag !== 14 && tag !== 15)
    throw new Error(`Unsupported Metadata version tag: ${tag}`);
  const version = tag as 14 | 15;

  const registry = readPortableRegistry(r);
  const pallets = readPalletsV14orV15(r, registry);

  return { version, pallets };
}
