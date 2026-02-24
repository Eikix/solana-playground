/**
 * Calls the recent-blockhash program's log_recent_hash instruction,
 * then reads the transaction logs to see what it printed.
 *
 * Usage:
 *   SOLANA_CLUSTER=localnet bun run scripts/run-recent-blockhash.ts
 *   SOLANA_CLUSTER=devnet bun run scripts/run-recent-blockhash.ts
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import {
	AccountRole,
	address,
	appendTransactionMessageInstruction,
	createKeyPairSignerFromBytes,
	createSolanaRpc,
	createSolanaRpcSubscriptions,
	createTransactionMessage,
	getSignatureFromTransaction,
	type Instruction,
	pipe,
	sendAndConfirmTransactionFactory,
	setTransactionMessageFeePayerSigner,
	setTransactionMessageLifetimeUsingBlockhash,
	signTransactionMessageWithSigners,
} from "@solana/kit";

const PROGRAM_ID = address("GEeGqsyMrqRBdBQwW4RsUeysWgp2RdRZnzBjMX11ozwi");
const SLOT_HASHES_SYSVAR = address("SysvarS1otHashes111111111111111111111111111");

// sha256("global:log_recent_hash")[..8]
const DISCRIMINATOR = new Uint8Array([252, 174, 104, 89, 199, 191, 29, 143]);

type Cluster = "localnet" | "devnet" | "testnet";

const CLUSTER_URLS: Record<Cluster, string> = {
	localnet: "http://127.0.0.1:8899",
	devnet: "https://api.devnet.solana.com",
	testnet: "https://api.testnet.solana.com",
};

const CLUSTER_WS_URLS: Record<Cluster, string> = {
	localnet: "ws://127.0.0.1:8900",
	devnet: "wss://api.devnet.solana.com",
	testnet: "wss://api.testnet.solana.com",
};

const cluster = (process.env.SOLANA_CLUSTER ?? "localnet") as Cluster;
const rpcUrl = CLUSTER_URLS[cluster];
const wsUrl = CLUSTER_WS_URLS[cluster];
console.log(`Cluster: ${cluster} (${rpcUrl})`);

// Load wallet keypair
const walletPath = `${homedir()}/.config/solana/id.json`;
const secretKey = new Uint8Array(JSON.parse(readFileSync(walletPath, "utf-8")));
const signer = await createKeyPairSignerFromBytes(secretKey);
console.log(`Wallet: ${signer.address}`);

const rpc = createSolanaRpc(rpcUrl);
const rpcSubscriptions = createSolanaRpcSubscriptions(wsUrl);

// Check balance
const balanceResult = await rpc.getBalance(signer.address).send();
console.log(`Balance: ${Number(balanceResult.value) / 1e9} SOL`);

// Get current slot for reference
const currentSlot = await rpc.getSlot().send();
console.log(`Current slot: ${currentSlot}`);

// Get the latest blockhash from RPC for comparison
const latestBlockhash = await rpc.getLatestBlockhash().send();
console.log(`Latest blockhash (from RPC): ${latestBlockhash.value.blockhash}`);
console.log(`  at last valid block height: ${latestBlockhash.value.lastValidBlockHeight}`);

// Build the instruction
const instruction: Instruction = {
	programAddress: PROGRAM_ID,
	accounts: [
		{
			address: SLOT_HASHES_SYSVAR,
			role: AccountRole.READONLY,
		},
	],
	data: DISCRIMINATOR,
};

// Build, sign, and send transaction
const txMessage = pipe(
	createTransactionMessage({ version: 0 }),
	(msg) => setTransactionMessageFeePayerSigner(signer, msg),
	(msg) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash.value, msg),
	(msg) => appendTransactionMessageInstruction(instruction, msg),
);

const signedTx = await signTransactionMessageWithSigners(txMessage);
const sig = getSignatureFromTransaction(signedTx);
console.log(`\nSending transaction...`);

const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
// biome-ignore lint/suspicious/noExplicitAny: kit v6 sendAndConfirm typing is overly strict
await (sendAndConfirm as any)(signedTx, { commitment: "confirmed" });
console.log(`Transaction confirmed: ${sig}`);

// Fetch transaction with logs
const txResult = await rpc
	.getTransaction(sig, {
		commitment: "confirmed",
		maxSupportedTransactionVersion: 0,
		encoding: "json",
	})
	.send();

if (txResult?.meta?.logMessages) {
	console.log("\n--- Program Logs ---");
	for (const log of txResult.meta.logMessages) {
		if (log.includes("Program log:")) {
			console.log(log);
		}
	}
}

// Cross-reference the slot our tx landed in
const txSlot = txResult?.slot;
if (txSlot) {
	console.log(`\n--- Cross-reference (slot ${txSlot}) ---`);
	console.log(`Transaction landed in slot: ${txSlot}`);
	try {
		const block = await rpc
			.getBlock(txSlot, {
				commitment: "confirmed",
				maxSupportedTransactionVersion: 0,
				transactionDetails: "none",
			})
			.send();
		if (block) {
			console.log(`Block blockhash: ${block.blockhash}`);
			console.log(`Previous blockhash: ${block.previousBlockhash}`);
			console.log(`Parent slot: ${block.parentSlot}`);
			console.log(`Block time: ${block.blockTime}`);
		}
	} catch (e) {
		console.log(`Could not fetch block: ${e}`);
	}
}

// Clean exit
process.exit(0);
