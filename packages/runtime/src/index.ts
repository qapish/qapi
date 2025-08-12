export interface RuntimeInfo {
  specName: string;
  specVersion: number;
  ss58Prefix?: number;
  metadata: Uint8Array;
}

export interface RpcLike {
  send(method: string, params?: any[]): Promise<any>;
}

export async function fetchRuntime(rpc: RpcLike): Promise<RuntimeInfo> {
  const [ver, meta, props] = await Promise.all([
    rpc.send("state_getRuntimeVersion"),
    rpc.send("state_getMetadata"),
    rpc.send("system_properties").catch(() => undefined),
  ]);
  return {
    specName: ver?.specName ?? "unknown",
    specVersion: Number(ver?.specVersion ?? 0),
    ss58Prefix: props?.ss58Format,
    metadata: hexToU8a(String(meta)),
  };
}

function hexToU8a(hex: string) {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
