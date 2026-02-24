import { describe, expect, test } from "bun:test";
import { getCluster, getRpc } from "./helpers/setup";

describe("example program", () => {
	test("RPC helper connects to cluster", async () => {
		const rpc = getRpc();
		// Basic connectivity check — will fail on localnet if no validator is running,
		// but that's expected. The point is the setup works.
		try {
			const slot = await rpc.getSlot().send();
			expect(slot).toBeGreaterThan(0);
		} catch {
			// If localnet isn't running, skip gracefully
			if (getCluster() === "localnet") {
				console.log("Skipping: localnet not running");
				return;
			}
			throw new Error("RPC connection failed");
		}
	});
});
