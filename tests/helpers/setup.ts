import { createSolanaRpc, createSolanaRpcSubscriptions } from "@solana/kit";

export type Cluster = "localnet" | "devnet" | "testnet";

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

export function getCluster(): Cluster {
	const env = process.env.SOLANA_CLUSTER;
	if (env && env in CLUSTER_URLS) return env as Cluster;
	return "localnet";
}

export function getRpc(cluster?: Cluster) {
	const c = cluster ?? getCluster();
	return createSolanaRpc(CLUSTER_URLS[c]);
}

export function getRpcSubscriptions(cluster?: Cluster) {
	const c = cluster ?? getCluster();
	return createSolanaRpcSubscriptions(CLUSTER_WS_URLS[c]);
}
