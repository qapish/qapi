import { WsProvider } from "@qapish/provider-ws";
import { fetchRuntime, type RuntimeInfo } from "@qapish/runtime";
import { encodeHeaderFromJson, headerHash } from "@qapish/scale";

export interface QapiConfig {
  provider: WsProvider;
  overrides?: {
    signature?: { scheme: "ml-dsa"; variant?: string };
    ss58Prefix?: number;
  };
}

export type Head = { hash: string; number: number };

export class Qapi {
  private constructor(
    private provider: WsProvider,
    private runtime: RuntimeInfo,
    private overrides?: QapiConfig["overrides"],
  ) {}

  static async connect(cfg: QapiConfig) {
    await cfg.provider.connect();
    const runtime = await fetchRuntime({
      send: (method: string, params: any[] = []) =>
        cfg.provider.send(method, params),
    } as any);
    return new Qapi(cfg.provider, runtime, cfg.overrides);
  }

  /** Access raw JSON-RPC send, in case callers need a method not yet wrapped */
  rpc = {
    send: (method: string, params: any[] = []) =>
      this.provider.send(method, params),
  };

  /** Chain head subscription (new heads); returns an unsubscribe function */
  /*
  chainHead = {
    subscribe: (cb: (h: Head) => void) =>
      this.provider.subscribe(
        "chain_subscribeNewHeads",
        "chain_unsubscribeNewHeads",
        [],
        (head: any) => cb({ hash: head.hash, number: Number(head.number) }),
      ),
  };
  chainHead = {
    subscribe: (cb: (h: { hash: string; number: number }) => void) =>
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
  */
  chainHead = {
    subscribe: (cb: (h: { hash: string; number: number }) => void) =>
      this.provider.subscribe(
        "chain_subscribeNewHeads",
        "chain_unsubscribeNewHeads",
        [],
        async (head: any) => {
          // head is the JSON header; compute hash locally
          const hash = head.hash ?? headerHash(head);
          const number = Number(head.number);
          cb({ hash, number });
        },
      ),
  };

  /** Blocks & headers */
  blocks = {
    get: async (numberOrHash: number | string) => {
      const hash =
        typeof numberOrHash === "number"
          ? await this.provider.send("chain_getBlockHash", [numberOrHash])
          : numberOrHash;

      // small retry to wait for import (new heads race)
      const tryGet = async () => this.provider.send("chain_getBlock", [hash]);
      let full: any = await tryGet();

      for (let i = 0; i < 4 && (full == null || full.block == null); i++) {
        await new Promise((r) => setTimeout(r, 150)); // ~600ms total
        full = await tryGet();
      }

      if (full && full.block) return full.block;
      if (full) return full; // some nodes return { extrinsics, header } directly

      // Fallback: at least return the header so callers can proceed
      const header = await this.provider.send("chain_getHeader", [hash]);
      return { header, extrinsics: [] as string[] };
    },

    authorOf: (_header: any) => {
      // TODO: parse digest logs and map to author via consensus/session info
      return undefined as string | undefined;
    },
  };

  /** Runtime helpers */
  runtimeInfo = () => ({
    specName: this.runtime.specName,
    specVersion: this.runtime.specVersion,
    ss58Prefix: this.overrides?.ss58Prefix ?? this.runtime.ss58Prefix,
  });

  /** Extrinsics decoding (SCALE) – stub, will use @qapish/scale */
  codec = {
    decodeExtrinsic: (hex: string) => ({
      section: "unknown",
      method: "unknown",
      args: [],
      raw: hex,
    }),
  };

  async disconnect() {
    (this.provider as any).close?.();
  }
}
