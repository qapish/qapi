import { WsProvider } from "@qapish/provider-ws";
import { Qapi } from "@qapish/substrate";
import { u8aToHex } from "@qapish/scale";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
    overrides: {
      signature: { scheme: "ml-dsa", variant: sigVariant },
      names: {
        pallets: {
          0: { name: "override-00" },
          1: {
            name: "override-01",
            calls: { 0: "override-00", 1: "override-01" },
          },
          // add as you learn them
        },
      },
    },
  });
  const metaHex =
    typeof (qapi as any).runtime?.metadata === "string"
      ? (qapi as any).runtime.metadata
      : u8aToHex((qapi as any).runtime.metadata);
  console.log("metadata head:", metaHex.slice(0, 66), "len:", metaHex.length);
  
  // Get the directory of the current script
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const outputPath = join(__dirname, "../metadata.hex");
  
  if (process.env.QAPI_DEBUG) {
    console.log("Writing metadata to:", outputPath);
    console.log("Current working directory:", process.cwd());
    console.log("Script directory:", __dirname);
  }
  
  writeFileSync(outputPath, metaHex);
  console.log("Metadata written to:", outputPath);

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
          `#${i}: ${name.signed ? "signed" : "unsigned"} ${name.pallet}.${name.method}${name.reason ? " (" + name.reason + ")" : ""}`,
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
