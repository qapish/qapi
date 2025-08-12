import { extractMetaTables } from "@qapish/scale/metadata";
import { hexToU8a, readExtrinsicPrefix } from "@qapish/scale";
import { WsProvider } from "@qapish/provider-ws";
import { fetchRuntime, type RuntimeInfo } from "@qapish/runtime";

export interface QapiConfig {
  provider: WsProvider;
  overrides?: {
    signature?: { scheme: "ml-dsa"; variant?: string };
    ss58Prefix?: number;
    names?: {
      pallets?: Record<
        number,
        { name: string; calls?: Record<number, string> }
      >;
    };
  };
}
type Head = { hash: string; number: number };
type MetaTables = ReturnType<typeof extractMetaTables>;

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
    } catch (error) {
      console.error("Failed to parse metadata:", (error as Error)?.message);
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
    try {
      const t = extractMetaTables(meta);
      if (spec) this.tablesBySpec.set(spec, t);
      return t;
    } catch {
      return this.tablesLatest;
    }
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
    decodeExtrinsicName: async (hex: string, opts?: { at?: string }) => {
      const table = await this.tablesForBlock(opts?.at);
      const u8 = hexToU8a(hex);
      const { isSigned, offset } = readExtrinsicPrefix(u8);

      const palletIdx = u8[offset] ?? 0xff;
      const callIdx = u8[offset + 1] ?? 0xff;

      // if metadata worked
      if (table) {
        const pallet = table.pallets.find((p) => p.index === palletIdx);
        const method = pallet?.calls?.[callIdx];
        return {
          pallet: pallet?.name ?? `unknown(${palletIdx})`,
          method: method ?? `unknown(${callIdx})`,
          signed: isSigned,
          reason: method
            ? undefined
            : pallet
              ? "call-index-out-of-range"
              : "pallet-index-not-found",
        };
      }

      // metadata failed → try manual override map
      const pm = this.overrides?.names?.pallets?.[palletIdx];
      const palletName = pm?.name ?? `unknown(${palletIdx})`;
      const methodName = pm?.calls?.[callIdx] ?? `unknown(${callIdx})`;

      return {
        pallet: palletName,
        method: methodName,
        signed: isSigned,
        reason: "no-metadata",
      };
    },
  };
}
