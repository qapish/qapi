import { WsProvider } from "@qapish/provider-ws";
import { Qapi } from "@qapish/substrate";
import { u8aToHex } from "@qapish/scale";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

type Args = {
  endpoint?: string;
  "sig-variant"?: "ml-dsa-44" | "ml-dsa-65" | "ml-dsa-87";
  tail?: string;
  help?: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (const a of argv) {
    const [k, v] = a.split("=");
    if (k.startsWith("--")) (args as any)[k.slice(2)] = v ?? true;
  }
  return args;
}

function showHelp() {
  console.log(`
Usage: pnpm --filter node-basic start -- [OPTIONS]

OPTIONS:
  --endpoint=<URL>      WebSocket endpoint to connect to (default: ws://127.0.0.1:9944)
  --sig-variant=<TYPE>  ML-DSA signature variant: ml-dsa-44, ml-dsa-65, or ml-dsa-87 (default: ml-dsa-65)
  --tail=<NUMBER>       Number of blocks to follow before disconnecting (default: 1, 0 = indefinite)
  --help                Show this help message

EXAMPLES:
  # Connect to local node and follow 1 block
  pnpm --filter node-basic start

  # Connect to Resonance testnet and follow 10 blocks
  pnpm --filter node-basic start -- --endpoint=wss://a.t.res.fm --sig-variant=ml-dsa-87 --tail=10
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  
  if (args.help) {
    showHelp();
    process.exit(0);
  }

  const {
    endpoint = "ws://127.0.0.1:9944",
    "sig-variant": sigVariant = "ml-dsa-65",
    tail = "1",
  } = args;

  // For graceful shutdown
  let unsubscribeFn: (() => void) | undefined;
  let qapiInstance: Qapi | undefined;

  const blocksToFollow = parseInt(tail, 10);
  if (isNaN(blocksToFollow) || blocksToFollow < 0) {
    console.error("Error: --tail must be a non-negative integer");
    showHelp();
    process.exit(1);
  }

  console.log(`Connecting to ${endpoint} ...`);
  qapiInstance = await Qapi.connect({
    provider: new WsProvider(endpoint),
    overrides: {
      signature: { scheme: "ml-dsa", variant: sigVariant },
      metadata: {
        // Provide pre-parsed metadata tables to bypass the parsing issue.
        // This is useful when the chain uses non-standard metadata formats
        // that the default parser cannot handle.
        //
        // The structure maps pallet and call indices to their names:
        // - Each pallet has a name and index
        // - Calls are specified as an array of objects with name and index
        // - Events can be specified similarly (not shown in this example)
        //
        // This allows proper decoding of extrinsics without needing to
        // successfully parse the full metadata.
        tables: {
          version: 14, // Assuming V14, but could be 15 or 16
          pallets: [
            { name: "System", index: 0, calls: [
              { name: "remark", index: 0 },
              { name: "set_heap_pages", index: 1 },
              { name: "set_code", index: 2 },
              { name: "set_code_without_checks", index: 3 },
              { name: "remark_with_event", index: 4 },
              { name: "set_storage", index: 5 },
              { name: "kill_storage", index: 6 },
              { name: "kill_prefix", index: 7 },
              { name: "authorize_upgrade", index: 8 },
              { name: "authorize_upgrade_without_checks", index: 9 },
              { name: "apply_authorized_upgrade", index: 10 }
            ] },
            { name: "Timestamp", index: 1, calls: [{ name: "set", index: 0 }] },
            { name: "Balances", index: 2, calls: [
              { name: "transfer_allow_death", index: 0 },
              { name: "set_balance_deprecated", index: 1 },
              { name: "force_transfer", index: 2 },
              { name: "transfer_keep_alive", index: 3 },
              { name: "transfer_all", index: 4 },
              { name: "force_unreserve", index: 5 },
              { name: "upgrade_accounts", index: 6 },
              { name: "transfer", index: 7 },
              { name: "force_set_balance", index: 8 }
            ] },
            { name: "TransactionPayment", index: 3 },
            { name: "Sudo", index: 4, calls: [
              { name: "sudo", index: 0 },
              { name: "sudo_unchecked_weight", index: 1 },
              { name: "set_key", index: 2 },
              { name: "sudo_as", index: 3 }
            ] },
            { name: "QPoW", index: 5 },
            { name: "Wormhole", index: 6 },
            { name: "MiningRewards", index: 7 },
            { name: "Vesting", index: 8, calls: [
              { name: "vest", index: 0 },
              { name: "vest_other", index: 1 },
              { name: "vested_transfer", index: 2 },
              { name: "force_vested_transfer", index: 3 },
              { name: "merge_schedules", index: 4 }
            ] },
            { name: "Preimage", index: 9, calls: [
              { name: "note_preimage", index: 0 },
              { name: "unnote_preimage", index: 1 },
              { name: "request_preimage", index: 2 },
              { name: "unrequest_preimage", index: 3 }
            ] },
            { name: "Scheduler", index: 10, calls: [
              { name: "schedule", index: 0 },
              { name: "cancel", index: 1 },
              { name: "schedule_named", index: 2 },
              { name: "cancel_named", index: 3 },
              { name: "schedule_after", index: 4 },
              { name: "schedule_named_after", index: 5 },
              { name: "set_retry", index: 6 },
              { name: "set_retry_named", index: 7 },
              { name: "cancel_retry", index: 8 }
            ] },
            { name: "Utility", index: 11, calls: [
              { name: "batch", index: 0 },
              { name: "as_derivative", index: 1 },
              { name: "batch_all", index: 2 },
              { name: "dispatch_as", index: 3 },
              { name: "force_batch", index: 4 },
              { name: "with_weight", index: 5 }
            ] },
            { name: "Referenda", index: 12, calls: [
              { name: "submit", index: 0 },
              { name: "place_decision_deposit", index: 1 },
              { name: "refund_decision_deposit", index: 2 },
              { name: "cancel", index: 3 },
              { name: "kill", index: 4 },
              { name: "nudge_referendum", index: 5 },
              { name: "one_fewer_deciding", index: 6 },
              { name: "refund_submission_deposit", index: 7 },
              { name: "set_metadata", index: 8 }
            ] },
            { name: "ReversibleTransfers", index: 13 },
            { name: "ConvictionVoting", index: 14, calls: [
              { name: "vote", index: 0 },
              { name: "delegate", index: 1 },
              { name: "undelegate", index: 2 },
              { name: "unlock", index: 3 },
              { name: "remove_vote", index: 4 },
              { name: "remove_other_vote", index: 5 }
            ] },
            { name: "TechCollective", index: 15, calls: [
              { name: "add_member", index: 0 },
              { name: "promote_member", index: 1 },
              { name: "demote_member", index: 2 },
              { name: "remove_member", index: 3 },
              { name: "vote", index: 4 },
              { name: "cleanup_poll", index: 5 }
            ] },
            { name: "TechReferenda", index: 16, calls: [
              { name: "submit", index: 0 },
              { name: "place_decision_deposit", index: 1 },
              { name: "refund_decision_deposit", index: 2 },
              { name: "cancel", index: 3 },
              { name: "kill", index: 4 },
              { name: "nudge_referendum", index: 5 },
              { name: "one_fewer_deciding", index: 6 },
              { name: "refund_submission_deposit", index: 7 },
              { name: "set_metadata", index: 8 }
            ] },
            { name: "MerkleAirdrop", index: 17 },
            { name: "TreasuryPallet", index: 18, calls: [
              { name: "propose_spend", index: 0 },
              { name: "reject_proposal", index: 1 },
              { name: "approve_proposal", index: 2 },
              { name: "spend", index: 3 },
              { name: "remove_approval", index: 4 },
              { name: "spend_local", index: 5 }
            ] },
            { name: "Origins", index: 19 },
            { name: "Recovery", index: 20, calls: [
              { name: "as_recovered", index: 0 },
              { name: "set_recovered", index: 1 },
              { name: "create_recovery", index: 2 },
              { name: "initiate_recovery", index: 3 },
              { name: "vouch_recovery", index: 4 },
              { name: "claim_recovery", index: 5 },
              { name: "close_recovery", index: 6 },
              { name: "remove_recovery", index: 7 },
              { name: "cancel_recovered", index: 8 }
            ] },
            { name: "Assets", index: 21, calls: [
              { name: "create", index: 0 },
              { name: "force_create", index: 1 },
              { name: "start_destroy", index: 2 },
              { name: "destroy_accounts", index: 3 },
              { name: "destroy_approvals", index: 4 },
              { name: "finish_destroy", index: 5 },
              { name: "mint", index: 6 },
              { name: "burn", index: 7 },
              { name: "transfer", index: 8 },
              { name: "transfer_keep_alive", index: 9 },
              { name: "force_transfer", index: 10 },
              { name: "freeze", index: 11 },
              { name: "thaw", index: 12 },
              { name: "freeze_asset", index: 13 },
              { name: "thaw_asset", index: 14 },
              { name: "transfer_ownership", index: 15 },
              { name: "set_team", index: 16 },
              { name: "set_metadata", index: 17 },
              { name: "clear_metadata", index: 18 },
              { name: "force_set_metadata", index: 19 },
              { name: "force_clear_metadata", index: 20 },
              { name: "force_asset_status", index: 21 },
              { name: "approve_transfer", index: 22 },
              { name: "cancel_approval", index: 23 },
              { name: "force_cancel_approval", index: 24 },
              { name: "transfer_approved", index: 25 },
              { name: "touch", index: 26 },
              { name: "refund", index: 27 },
              { name: "set_min_balance", index: 28 },
              { name: "touch_other", index: 29 },
              { name: "refund_other", index: 30 },
              { name: "block", index: 31 }
            ] },
          ],
        },
      },
    },
  });
  const qapi = qapiInstance;
  
  // Set up graceful shutdown for indefinite following
  if (blocksToFollow === 0) {
    process.on('SIGINT', async () => {
      console.log('\n\nReceived interrupt signal, shutting down gracefully...');
      if (unsubscribeFn) {
        unsubscribeFn();
      }
      if (qapiInstance) {
        await qapiInstance.disconnect();
      }
      process.exit(0);
    });
  }
  
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
  console.log(`Following chain for ${blocksToFollow === 0 ? 'indefinite blocks' : `${blocksToFollow} block${blocksToFollow > 1 ? 's' : ''}`}...`);

  let blocksProcessed = 0;
  unsubscribeFn = await qapi.chainHead.subscribe(
    async ({ number, hash }) => {
      console.log(`\nNew head: #${number} ${hash}`);
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

      blocksProcessed++;
      if (blocksToFollow > 0 && blocksProcessed >= blocksToFollow) {
        console.log(`\nProcessed ${blocksProcessed} block${blocksProcessed > 1 ? 's' : ''}, unsubscribing...`);
        unsubscribeFn?.(); // unsubscribe first
        await qapi.disconnect(); // then close the WS cleanly
      }
    },
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
