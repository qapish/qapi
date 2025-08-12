import { extractMetaTables } from "@qapish/scale/metadata";
import { hexToU8a, readExtrinsicPrefix } from "@qapish/scale";
import { WsProvider } from "@qapish/provider-ws";
import { fetchRuntime, type RuntimeInfo } from "@qapish/runtime";

export interface QapiConfig {
  provider: WsProvider;
  overrides?: {
    signature?: { scheme: "ml-dsa"; variant?: string };
    ss58Prefix?: number;
  };
}

type Head = { hash: string; number: number };
type MetaTables = ReturnType<typeof extractMetaTables>;
type Extractor = typeof extractMetaTables;

async function tryExtract(
  meta: Uint8Array,
  primary: Extractor,
): Promise<ReturnType<Extractor> | undefined> {
  try {
    return primary(meta);
  } catch {
    /* try fallback below */
  }
  try {
    // dynamic optional import (won't crash if not installed)
    const mod = await import("@qapish/metadata-polkadot").catch(
      () => null as any,
    );
    if (mod?.extractMetaTablesCompat) {
      return mod.extractMetaTablesCompat(meta);
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

function hexPreview(u8: Uint8Array | string, n = 24): string {
  const raw =
    typeof u8 === "string"
      ? u8.slice(0, 2 + n * 2)
      : (() => {
          let s = "0x";
          const b = u8.subarray(0, Math.min(n, u8.length));
          for (let i = 0; i < b.length; i++)
            s += b[i]!.toString(16).padStart(2, "0");
          return s;
        })();
  return typeof u8 === "string" ? raw : raw;
}

export class Qapi {
  private tablesLatest?: MetaTables;
  private tablesBySpec = new Map<number, MetaTables>();

  private constructor(
    private provider: WsProvider,
    private runtime: RuntimeInfo,
    private overrides?: QapiConfig["overrides"],
  ) {}

  static async connect(cfg: QapiConfig) {
    await cfg.provider.connect();
    const runtime = await fetchRuntime({
      send: (m: string, p: any[] = []) => cfg.provider.send(m, p),
    } as any);
    const api = new Qapi(cfg.provider, runtime, cfg.overrides);

    try {
      api.tablesLatest = extractMetaTables(runtime.metadata);
      api.tablesBySpec.set(runtime.specVersion, api.tablesLatest);
      if (process.env.QAPI_DEBUG) {
        console.log(
          "metadata parsed:",
          api.tablesLatest.version,
          "pallets:",
          api.tablesLatest.pallets.length,
        );
      }
    } catch (err) {
      console.error(
        "metadata: primary extractor failed:",
        (err as Error)?.message ?? err,
      );
      // fallback (if you kept it)
      try {
        const mod = await import("@qapish/metadata-polkadot").catch(
          () => null as any,
        );
        if (mod?.extractMetaTablesCompat) {
          const t = mod.extractMetaTablesCompat(runtime.metadata);
          api.tablesLatest = t;
          api.tablesBySpec.set(runtime.specVersion, t);
          console.log(
            "metadata parsed via polkadot adapter:",
            t.version,
            "pallets:",
            t.pallets.length,
          );
        } else {
          console.warn(
            "metadata: no tables; will fall back to indices; meta head:",
            hexPreview(runtime.metadata),
          );
        }
      } catch (e2) {
        console.warn(
          "metadata: adapter failed; will fall back to indices; meta head:",
          hexPreview(runtime.metadata),
          "adapter error:",
          (e2 as Error)?.message ?? e2,
        );
      }
    }

    return api;
  }

  private async tablesForBlock(hash?: string): Promise<MetaTables | undefined> {
    if (!hash) return this.tablesLatest;
    const ver = await this.provider
      .send("state_getRuntimeVersion", [hash])
      .catch(() => undefined);
    const spec = ver?.specVersion;
    if (spec && this.tablesBySpec.has(spec)) return this.tablesBySpec.get(spec);
    const meta = await this.provider
      .send("state_getMetadata", [hash])
      .catch(() => undefined);
    if (!meta) return this.tablesLatest;
    const t = await tryExtract(meta, extractMetaTables);
    if (t && spec) this.tablesBySpec.set(spec, t);
    return t ?? this.tablesLatest;
  }

  async disconnect() {
    (this.provider as any).close?.();
  }

  rpc = { send: (m: string, p: any[] = []) => this.provider.send(m, p) };

  chainHead = {
    subscribe: (cb: (h: Head) => void) =>
      this.provider.subscribe(
        "chain_subscribeNewHeads",
        "chain_unsubscribeNewHeads",
        [],
        async (head: any) => {
          const number = Number(head.number);
          const hash =
            head.hash ??
            (await this.provider.send("chain_getBlockHash", [number]));
          cb({ hash, number });
        },
      ),
  };

  blocks = {
    get: async (numberOrHash: number | string) => {
      const hash =
        typeof numberOrHash === "number"
          ? await this.provider.send("chain_getBlockHash", [numberOrHash])
          : numberOrHash;
      const tryGet = async () => this.provider.send("chain_getBlock", [hash]);
      let full: any = await tryGet();
      for (let i = 0; i < 4 && (full == null || full.block == null); i++) {
        await new Promise((r) => setTimeout(r, 150));
        full = await tryGet();
      }
      if (full && full.block) return full.block;
      if (full) return full;
      const header = await this.provider.send("chain_getHeader", [hash]);
      return { header, extrinsics: [] as string[] };
    },
    authorOf: (_header: any) => undefined as string | undefined,
  };

  runtimeInfo = () => ({
    specName: this.runtime.specName,
    specVersion: this.runtime.specVersion,
    ss58Prefix: this.overrides?.ss58Prefix ?? this.runtime.ss58Prefix,
  });

  codec = {
    // Unsigned extrinsics → names; signed → show indices + reason (until skipper lands)
    decodeExtrinsicName: async (hex: string, opts?: { at?: string }) => {
      const t = await this.tablesForBlock(opts?.at);
      const u8 = hexToU8a(hex);
      const { isSigned, offset } = readExtrinsicPrefix(u8);

      const palletIdx = u8[offset] ?? 0xff;
      const callIdx = u8[offset + 1] ?? 0xff;

      if (!t) {
        return {
          pallet: `unknown(${palletIdx})`,
          method: `unknown(${callIdx})`,
          signed: isSigned,
          reason: "no-metadata",
        };
      }

      const pallet = t.pallets.find((p) => p.index === palletIdx);
      const method = pallet?.calls?.[callIdx];

      if (isSigned) {
        return {
          pallet: pallet?.name ?? `unknown(${palletIdx})`,
          method: method ?? `unknown(${callIdx})`,
          signed: true,
          reason: "signed-not-parsed",
        };
      }
      return {
        pallet: pallet?.name ?? `unknown(${palletIdx})`,
        method: method ?? `unknown(${callIdx})`,
        signed: false,
      };
    },

    // Map [palletIdx, eventIdx] → "pallet.event" using metadata tables.
    decodeEventName: async (
      palletIdx: number,
      eventIdx: number,
      opts?: { at?: string },
    ) => {
      const t = await this.tablesForBlock(opts?.at);
      if (!t)
        return {
          pallet: `unknown(${palletIdx})`,
          event: `unknown(${eventIdx})`,
          reason: "no-metadata",
        };
      const pallet = t.pallets.find((p) => p.index === palletIdx);
      const event = pallet?.events?.[eventIdx];
      return {
        pallet: pallet?.name ?? `unknown(${palletIdx})`,
        event: event ?? `unknown(${eventIdx})`,
      };
    },
  };
}
