import { WsProvider } from "@qapish/provider-ws";
import { Qapi } from "@qapish/substrate";

type Args = {
  endpoint?: string;
  "sig-variant"?: "ml-dsa-44" | "ml-dsa-65" | "ml-dsa-87";
};
function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (const a of argv) {
    const [k, v] = a.split("=");
    if (k.startsWith("--")) (args as any)[k.slice(2)] = v ?? true;
  }
  return args;
}

async function main() {
  const {
    endpoint = "ws://127.0.0.1:9944",
    "sig-variant": sigVariant = "ml-dsa-65",
  } = parseArgs(process.argv.slice(2));

  console.log(`Connecting to ${endpoint} ...`);
  const qapi = await Qapi.connect({
    provider: new WsProvider(endpoint),
    overrides: { signature: { scheme: "ml-dsa", variant: sigVariant } },
  });

  const rt = qapi.runtimeInfo();
  console.log(
    `Runtime: specName=${rt.specName} specVersion=${rt.specVersion} ss58Prefix=${rt.ss58Prefix ?? "?"}`,
  );

  const unsubscribe = await qapi.chainHead.subscribe(
    async ({ number, hash }) => {
      console.log(`New head: #${number} ${hash}`);
      const block = await qapi.blocks.get(hash);

      const extCount =
        block?.extrinsics && Array.isArray(block.extrinsics)
          ? block.extrinsics.length
          : 0;

      console.log(`Extrinsics: ${extCount}`);

      for (const [i, exHex] of block.extrinsics.entries()) {
        const name = await qapi.codec.decodeExtrinsicName(exHex, { at: hash });
        console.log(
          `#${i}: ${name.signed ? "signed" : "unsigned"} ${name.pallet}.${name.method}` +
            (name.reason ? ` (${name.reason})` : ""),
        );
      }

      unsubscribe?.(); // unsubscribe first
      await qapi.disconnect(); // then close the WS cleanly
    },
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
