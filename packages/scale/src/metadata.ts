// Minimal metadata reader for V14/V15 that extracts pallet names, indices,
// and the variant names for both CALLS and EVENTS enums.
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
  private o = 0;
  constructor(private u8: Uint8Array) {}
  get offset() {
    return this.o;
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
}

// ----------------- portable registry (only what we need) -----------------
type TypeDef = {
  kind: "Variant" | "Other";
  variants?: { name: string; index: number }[];
};
function readPortableType(r: Reader): { id: number; def: TypeDef } {
  const id = r.compactU32();
  const _path = r.vec(() => r.text());
  const _params = r.vec(() => {
    const nm = r.text();
    const ty = r.option(() => r.compactU32());
    return { nm, ty };
  });
  const tag = r.u8_();
  let def: TypeDef = { kind: "Other" };

  if (tag === 1 /* Variant */) {
    const variants = r.vec(() => {
      const vName = r.text();
      const _fields = r.vec(() => {
        const _fname = r.option(() => r.text());
        const _ty = r.compactU32();
        const _tname = r.option(() => r.text());
        const _docs = r.vec(() => r.text());
        return 0;
      });
      const index = r.u8_();
      const _docs = r.vec(() => r.text());
      return { name: vName, index };
    });
    def = { kind: "Variant", variants };
  } else {
    // skip payload of other defs (best-effort)
    switch (tag) {
      case 0: {
        /* Composite */ r.vec(() => {
          const _fname = r.option(() => r.text());
          const _ty = r.compactU32();
          const _tname = r.option(() => r.text());
          const _docs = r.vec(() => r.text());
          return 0;
        });
        break;
      }
      case 2: {
        /* Sequence */ r.compactU32();
        break;
      }
      case 3: {
        /* Array    */ r.compactU32();
        r.compactU32();
        break;
      }
      case 4: {
        /* Tuple    */ r.vec(() => r.compactU32());
        break;
      }
      case 5: {
        /* Primitive*/ r.u8_();
        break;
      }
      case 6: {
        /* Compact  */ r.compactU32();
        break;
      }
      case 7: {
        /* BitSeq   */ r.compactU32();
        r.compactU32();
        break;
      }
      case 8: {
        /* Historic */ break;
      }
      default:
        break;
    }
  }
  const _docs = r.vec(() => r.text());
  return { id, def };
}
function readPortableRegistry(r: Reader): Map<number, TypeDef> {
  const types = r.vec(() => readPortableType(r));
  const m = new Map<number, TypeDef>();
  for (const t of types) m.set(t.id, t.def);
  return m;
}

function readPalletsV14orV15(r: Reader, registry: Map<number, TypeDef>) {
  return r.vec(() => {
    const name = r.text();

    // storage: Option<...> (skip)
    r.option(() => {
      const _prefix = r.text();
      const _items = r.vec(() => {
        const _name = r.text();
        const _modifier = r.u8_();
        const _tyTag = r.u8_();
        switch (_tyTag) {
          case 0: {
            r.compactU32();
            break;
          }
          case 1: {
            r.compactU32();
            r.compactU32();
            break;
          }
          default:
            break;
        }
        const _fallback = r.bytes(r.compactU32());
        const _docs = r.vec(() => r.text());
        return 0;
      });
      const _cache = r.u8_();
      return 0;
    });

    // calls/events are Option<Compact<u32>> referencing registry type ids
    const callsTy = r.option(() => r.compactU32());
    const eventsTy = r.option(() => r.compactU32());

    // constants (skip)
    r.vec(() => {
      const _n = r.text();
      const _ty = r.compactU32();
      const _v = r.bytes(r.compactU32());
      const _d = r.vec(() => r.text());
      return 0;
    });

    // errors: V14 Option<Type>; V15 Vec<ErrorMetadata>. Best-effort skip both.
    const tagOrLen = r.u8_();
    if (tagOrLen === 0 || tagOrLen === 1) {
      if (tagOrLen === 1) r.compactU32();
    } else {
      (r as any).o -= 1;
      r.vec(() => {
        const _nm = r.text();
        const _docs = r.vec(() => r.text());
        return 0;
      });
    }

    const index = r.u8_();

    const calls = callsTy ? readVariantNames(registry, callsTy) : undefined;
    const events = eventsTy ? readVariantNames(registry, eventsTy) : undefined;

    return { name, index, calls, events };
  });
}

function readVariantNames(
  registry: Map<number, TypeDef>,
  typeId: number,
): string[] | undefined {
  const def = registry.get(typeId);
  if (def?.kind !== "Variant" || !def.variants) return undefined;
  const ordered = [...def.variants].sort((a, b) => a.index - b.index);
  return ordered.map((v) => v.name);
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
