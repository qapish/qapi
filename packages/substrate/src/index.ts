import { WsProvider } from "@qapish/provider-ws";
import { fetchRuntime } from "@qapish/runtime";
import { decodeHeader } from "@qapish/scale";

export interface QapiConfig {
  provider: WsProvider;
  overrides?: { signature?: { scheme: "ml-dsa"; variant?: string }; ss58Prefix?: number };
}

export class Qapi {
  private constructor(
    private provider: WsProvider,
    private runtime: Awaited<ReturnType<typeof fetchRuntime>>,
    private overrides?: QapiConfig["overrides"],
  ) {}

  static async connect(cfg: QapiConfig) {
    await cfg.provider.connect();
    const runtime = await fetchRuntime(cfg.provider);
    return new Qapi(cfg.provider, runtime, cfg.overrides);
  }

  chainHead = {
    subscribe: (cb: (h: { hash: string; number: number }) => void) =>
      this.provider.subscribe("chain_subscribeNewHeads", "chain_unsubscribeNewHeads", [], (head: any) => {
        cb({ hash: head.hash, number: Number(head.number) });
      }),
  };

  blocks = {
    get: async (numberOrHash: number | string) => {
      const hash = typeof numberOrHash === "number"
        ? await this.provider.send("chain_getBlockHash", [numberOrHash])
        : numberOrHash;
      const full = await this.provider.send("chain_getBlock", [hash]);
      const header = decodeHeader(hexToU8a(full.block.header));
      return { header, extrinsics: full.block.extrinsics };
    },
    authorOf: (header: any) => {
      // TODO: inspect header.digest logs -> engine IDs (AURA/BABE/POW) and derive author
      return undefined as string | undefined;
    },
  };

  codec = {
    decodeExtrinsic: (hex: string) => {
      // TODO: use @qapish/scale with metadata to decode
      return { section: "unknown", method: "unknown", args: [] as any[] };
    },
  };
}

function hexToU8a(hex: string) {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
