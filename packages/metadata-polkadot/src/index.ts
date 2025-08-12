// Convert metadata hex -> { version, pallets[{name,index,calls[],events[]}] }
import type { MetaTables } from "@qapish/scale/metadata";
import { hexToU8a } from "@qapish/scale";
import { Metadata } from "@polkadot/metadata";
import { TypeRegistry } from "@polkadot/types/create";
import { u8aConcat, u8aToU8a } from "@polkadot/util";

// Unwrap Vec<u8> and strip "meta" magic if present:
function unwrap(metaHexOrBytes: string | Uint8Array) {
  const raw =
    typeof metaHexOrBytes === "string"
      ? hexToU8a(metaHexOrBytes)
      : u8aToU8a(metaHexOrBytes);

  // Vec<u8> wrapper?
  let inner = raw;
  try {
    let off = 0;
    const b0 = raw[off++]!;
    const mode = b0 & 0b11;
    const len =
      mode === 0
        ? b0 >> 2
        : mode === 1
          ? (b0 >> 2) | (raw[off++]! << 6)
          : mode === 2
            ? (b0 >> 2) |
              (raw[off++]! << 6) |
              (raw[off++]! << 14) |
              (raw[off++]! << 22)
            : -1;
    if (len >= 0 && off + len === raw.length) {
      inner = raw.subarray(off, off + len);
    }
  } catch {
    /* ignore */
  }

  // strip "meta" magic
  if (
    inner.length >= 5 &&
    inner[0] === 0x6d &&
    inner[1] === 0x65 &&
    inner[2] === 0x74 &&
    inner[3] === 0x61
  ) {
    inner = inner.subarray(4);
  }
  return inner;
}

export function extractMetaTablesCompat(
  metaHexOrBytes: string | Uint8Array,
): MetaTables {
  const inner = unwrap(metaHexOrBytes);

  // Polkadot TypeRegistry can decode any current metadata version
  const registry = new TypeRegistry();
  const md = new Metadata(registry, inner);
  md.registry.setMetadata(md);

  // Pull pallets with their indices; extract calls/events variant names when present
  const pallets = md.asLatest.pallets.map(
    (p: any): MetaTables["pallets"][number] => {
      const name = p.name.toString();
      const index = Number(p.index.toPrimitive());

      let calls: string[] | undefined;
      try {
        const callEnum = md.registry.lookup.getSiType(p.calls.unwrap().type).def
          .asVariant;
        calls = callEnum.variants.map((v: any) => v.name.toString());
      } catch {
        /* no calls or lookup failed */
      }

      let events: string[] | undefined;
      try {
        const eventEnum = md.registry.lookup.getSiType(p.events.unwrap().type)
          .def.asVariant;
        events = eventEnum.variants.map((v: any) => v.name.toString());
      } catch {
        /* no events or lookup failed */
      }

      return { name, index, calls, events };
    },
  );

  // Version is available via md.version (u8)
  const version = md.version as 14 | 15 | 16; // polkadot-js supports newer too; we coerce to our union

  return { version, pallets };
}
