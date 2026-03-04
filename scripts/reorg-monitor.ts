/**
 * Solana Fork Instability Monitor
 *
 * Tracks 5 outcome-based fork instability metrics:
 *   M1: Slot Hash Change — same provider returns different blockhash for same slot
 *   M2: Cross-RPC Divergence — different providers return different blockhashes
 *   M3: Processed-Finalized Gap — processedSlot - finalizedSlot trend
 *   M4: Time to Root — latency from first-seen-processed to finalized
 *   M5: Fork Depth — consecutive slots where hash changed (triggered by M1)
 *
 * Uses active blockhash polling via getBlock() across multiple RPC providers.
 * WS subscriptions on provider[0] for slot lifecycle (processed→confirmed→finalized).
 *
 * Usage:
 *   RPC_URLS=url1,url2 bun run monitor
 *   SOLANA_CLUSTER=devnet bun run monitor
 *   bun run monitor --verify
 *   bun run monitor --reset
 */

const VERIFY_MODE = process.argv.includes("--verify");
const RESET_MODE = process.argv.includes("--reset");

import { Database } from "bun:sqlite";
import {
	createSolanaRpc,
	createSolanaRpcSubscriptions,
	createSolanaRpcSubscriptions_UNSTABLE,
} from "@solana/kit";

// ─── Cluster config ─────────────────────────────────────────────────────────

type Cluster = "localnet" | "devnet" | "testnet" | "mainnet-beta";

const CLUSTER_URLS: Record<Cluster, string> = {
	localnet: "http://127.0.0.1:8899",
	devnet: "https://api.devnet.solana.com",
	testnet: "https://api.testnet.solana.com",
	"mainnet-beta": "https://api.mainnet-beta.solana.com",
};

const CLUSTER_WS_URLS: Record<Cluster, string> = {
	localnet: "ws://127.0.0.1:8900",
	devnet: "wss://api.devnet.solana.com",
	testnet: "wss://api.testnet.solana.com",
	"mainnet-beta": "wss://api.mainnet-beta.solana.com",
};

const cluster = (process.env.SOLANA_CLUSTER ?? "mainnet-beta") as Cluster;
if (!(cluster in CLUSTER_URLS)) {
	console.error(`Unknown cluster: ${cluster}`);
	process.exit(1);
}

// ─── Provider infrastructure ─────────────────────────────────────────────────

interface ProviderConfig {
	name: string;
	rpcUrl: string;
	wsUrl: string;
	rpc: ReturnType<typeof createSolanaRpc>;
}

interface ProviderHealth {
	lastSuccess: number;
	consecutiveErrors: number;
}

function deriveWsUrl(httpUrl: string): string {
	return httpUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
}

function initProviders(): ProviderConfig[] {
	const result: ProviderConfig[] = [];

	// Try RPC_URLS first (comma-separated)
	const rpcUrls = process.env.RPC_URLS;
	if (rpcUrls) {
		const urls = rpcUrls
			.split(",")
			.map((u) => u.trim())
			.filter(Boolean);
		for (let i = 0; i < urls.length; i++) {
			const rpcUrl = urls[i];
			const wsUrl = process.env[`WS_URL_${i + 1}`] ?? deriveWsUrl(rpcUrl);
			result.push({ name: `provider-${i}`, rpcUrl, wsUrl, rpc: createSolanaRpc(rpcUrl) });
		}
	}

	// Try numbered RPC_URL_N
	if (result.length === 0) {
		for (let i = 1; i <= 10; i++) {
			const rpcUrl = process.env[`RPC_URL_${i}`];
			if (!rpcUrl) break;
			const wsUrl = process.env[`WS_URL_${i}`] ?? deriveWsUrl(rpcUrl);
			result.push({
				name: `provider-${i - 1}`,
				rpcUrl,
				wsUrl,
				rpc: createSolanaRpc(rpcUrl),
			});
		}
	}

	// Fallback: for mainnet-beta use known free providers; others get cluster default
	if (result.length === 0) {
		const defaults =
			cluster === "mainnet-beta"
				? [
						{ name: "publicnode", url: "https://solana-rpc.publicnode.com" },
						{ name: "vibe-station", url: "https://public.rpc.solanavibestation.com" },
						{ name: "subquery", url: "https://solana.rpc.subquery.network/public" },
					]
				: [{ name: "provider-0", url: CLUSTER_URLS[cluster] }];

		for (const d of defaults) {
			const wsUrl = cluster !== "mainnet-beta" ? CLUSTER_WS_URLS[cluster] : deriveWsUrl(d.url);
			result.push({ name: d.name, rpcUrl: d.url, wsUrl, rpc: createSolanaRpc(d.url) });
		}
	}

	return result;
}

const providers = initProviders();
const providerHealthMap: ProviderHealth[] = providers.map(() => ({
	lastSuccess: 0,
	consecutiveErrors: 0,
}));
const rpc = providers[0].rpc;

// ─── Constants ──────────────────────────────────────────────────────────────

const DROP_TIMEOUT_MS = 30_000;
const PRUNE_FINALIZED_AGE_MS = 120_000;
const PRUNE_DROPPED_AGE_MS = 60_000;
const POLL_INTERVAL_MS = 5_000;
const DASHBOARD_INTERVAL_MS = 2_000;
const RECONNECT_DELAY_MS = 2_000;
const TTR_MAX_SAMPLES = 1_000;
const OBS_FRESHNESS_MS = 15_000; // M2: only compare observations this fresh
const GAP_TREND_WINDOW = 12; // 1 minute at 5s interval

// ─── Types ──────────────────────────────────────────────────────────────────

interface BlockhashObservation {
	blockhash: string;
	parentSlot: bigint;
	previousBlockhash: string;
	fetchedAt: number;
}

interface SlotHashRecord {
	slot: bigint;
	observations: Map<number, BlockhashObservation[]>; // provider index → history
	createdAt: number;
	firstSeenProcessed: number | null; // from WS
	sawConfirmed: boolean;
	sawFinalized: boolean;
	finalizedAt: number | null;
	isDead: boolean;
	deadReason: string | null;
	dropCounted: boolean;
	isGapSlot: boolean;
	hashChanged: boolean;
	timeToRootMs: number | null;
}

interface DivergenceWindow {
	slot: bigint;
	startedAt: number;
	endedAt: number | null;
	providerHashes: Map<number, string>;
	convergedTo: string | null;
}

interface HashChangeEvent {
	slot: bigint;
	providerIndex: number;
	oldBlockhash: string;
	newBlockhash: string;
	detectedAt: number;
	consecutiveDepth: number;
}

interface ForkEvent {
	slot: bigint;
	detectedAt: number;
	type: "slot_drop" | "confirmed_not_finalized";
	detail: string;
}

interface SessionStats {
	totalProcessed: number;
	totalConfirmed: number;
	totalFinalized: number;
	totalDead: number;
	totalDropped: number;
	totalSkipped: number;
	totalHashChanges: number;
	totalDivergences: number;
	maxGapPF: number;
	maxConsecutiveDepth: number;
	ttrMaxMs: number;
	confirmedNotFinalized: number;
}

// ─── State ──────────────────────────────────────────────────────────────────

const slotMap = new Map<bigint, SlotHashRecord>();
const pendingForkEvents: ForkEvent[] = [];
const pendingHashChangeEvents: HashChangeEvent[] = [];
const pendingDivergenceEvents: DivergenceWindow[] = [];
const openDivergences = new Map<bigint, DivergenceWindow>();
const recentEvents: Array<{ time: number; label: string; detail: string }> = [];
const MAX_RECENT = 5;

const stats: SessionStats = {
	totalProcessed: 0,
	totalConfirmed: 0,
	totalFinalized: 0,
	totalDead: 0,
	totalDropped: 0,
	totalSkipped: 0,
	totalHashChanges: 0,
	totalDivergences: 0,
	maxGapPF: 0,
	maxConsecutiveDepth: 0,
	ttrMaxMs: 0,
	confirmedNotFinalized: 0,
};

let pollProcessed: bigint | null = null;
let pollConfirmed: bigint | null = null;
let pollFinalized: bigint | null = null;
let lastSeenSlot: bigint = 0n;
const startTime = Date.now();

// Health tracking
let lastPollSuccess = 0;
let lastWsSlotEvent = 0;
let lastWsUpdateEvent = 0;
let wsSlotReconnects = 0;
let wsUpdateReconnects = 0;

// M3: Gap tracking
const gapPfSamples: number[] = [];

// M4: Time to Root tracking
const ttrSamples: number[] = [];

// M5: Fork depth tracking
let maxDepthThisHour = 0;
let currentHour = new Date().getHours();

// Blockhash polling state
let lastPolledConfirmedSlot: bigint | null = null;
let maxDivergenceDurationMs = 0;

// ─── Rate tracker ───────────────────────────────────────────────────────────

class RateTracker {
	private buckets: number[] = [];
	private windowMs: number;

	constructor(windowSeconds = 300) {
		this.windowMs = windowSeconds * 1000;
	}

	record(): void {
		this.buckets.push(Date.now());
	}

	rate(): number {
		const cutoff = Date.now() - this.windowMs;
		let lo = 0;
		let hi = this.buckets.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (this.buckets[mid] < cutoff) lo = mid + 1;
			else hi = mid;
		}
		if (lo > 0) this.buckets.splice(0, lo);
		const elapsed = Math.min(Date.now() - startTime, this.windowMs);
		if (elapsed < 1000) return 0;
		return this.buckets.length / (elapsed / 1000);
	}
}

// ─── Adaptive rate controller (per provider) ────────────────────────────────

class AdaptiveRateController {
	private tokensPerCycle: number;
	private consecutiveClean = 0;
	total429s = 0;

	constructor(
		private readonly minTokens: number,
		private readonly maxTokens: number,
		initialTokens: number,
	) {
		this.tokensPerCycle = initialTokens;
	}

	/** How many getBlock calls this provider may use this cycle */
	getTokens(): number {
		return Math.floor(this.tokensPerCycle);
	}

	/** Call after each cycle with results for this provider */
	reportCycle(successes: number, failures429: number): void {
		if (failures429 > 0) {
			// Multiplicative decrease
			this.tokensPerCycle = Math.max(this.minTokens, this.tokensPerCycle * 0.5);
			this.consecutiveClean = 0;
			this.total429s += failures429;
		} else if (successes > 0) {
			this.consecutiveClean++;
			// Additive increase after 2 clean cycles
			if (this.consecutiveClean >= 2) {
				this.tokensPerCycle = Math.min(this.maxTokens, this.tokensPerCycle + 2);
			}
		}
	}
}

// Per-provider rate controllers: start at 15 tokens/cycle (3 req/s), ramp up to 75 (15 req/s)
const rateControllers: AdaptiveRateController[] = providers.map(
	() => new AdaptiveRateController(2, 75, 15),
);

const rateProcessed = new RateTracker();
const rateConfirmed = new RateTracker();
const rateFinalized = new RateTracker();
const rateDead = new RateTracker();
const rateDropped = new RateTracker();
const rateSkipped = new RateTracker();

// ─── SQLite layer ───────────────────────────────────────────────────────────

const dbPath = `reorg-monitor-${cluster}.db`;
const db = VERIFY_MODE ? new Database(dbPath, { readonly: true }) : new Database(dbPath);
if (!VERIFY_MODE) db.exec("PRAGMA journal_mode=WAL;");

if (!VERIFY_MODE) {
	db.exec(`
		CREATE TABLE IF NOT EXISTS stats (
			key TEXT PRIMARY KEY,
			value INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS cursor (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			last_finalized_slot INTEGER NOT NULL,
			last_run_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS fork_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			slot INTEGER NOT NULL,
			detected_at TEXT NOT NULL,
			type TEXT NOT NULL,
			parent_expected INTEGER,
			parent_actual INTEGER,
			detail TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS hash_change_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			slot INTEGER NOT NULL,
			provider_index INTEGER NOT NULL,
			old_blockhash TEXT NOT NULL,
			new_blockhash TEXT NOT NULL,
			detected_at TEXT NOT NULL,
			consecutive_depth INTEGER NOT NULL DEFAULT 1
		);
		CREATE TABLE IF NOT EXISTS divergence_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			slot INTEGER NOT NULL,
			started_at TEXT NOT NULL,
			ended_at TEXT,
			duration_ms INTEGER,
			provider_hashes TEXT NOT NULL,
			converged_to TEXT
		);
	`);

	// Migration: add first_monitored_slot column if missing
	const cols = db.prepare("PRAGMA table_info(cursor)").all() as Array<{ name: string }>;
	if (!cols.some((c) => c.name === "first_monitored_slot")) {
		db.exec("ALTER TABLE cursor ADD COLUMN first_monitored_slot INTEGER");
	}
}

if (RESET_MODE) {
	db.exec(
		"DELETE FROM stats; DELETE FROM cursor; DELETE FROM fork_events; " +
			"DELETE FROM hash_change_events; DELETE FROM divergence_events;",
	);
	console.log(`Reset: cleared all data in ${dbPath}`);
}

const STAT_KEYS = [
	"total_processed",
	"total_confirmed",
	"total_finalized",
	"total_dead",
	"total_dropped",
	"total_skipped",
	"total_hash_changes",
	"total_divergences",
	"max_gap_pf",
	"max_consecutive_depth",
	"ttr_max_ms",
	"confirmed_not_finalized",
] as const;

const upsertStat = VERIFY_MODE
	? null
	: db.prepare(
			"INSERT INTO stats (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?",
		);
if (!VERIFY_MODE) {
	for (const key of STAT_KEYS) {
		const row = db.prepare("SELECT value FROM stats WHERE key = ?").get(key) as {
			value: number;
		} | null;
		if (!row) upsertStat?.run(key, 0, 0);
	}
}

function loadPersistedStats(): void {
	for (const key of STAT_KEYS) {
		const row = db.prepare("SELECT value FROM stats WHERE key = ?").get(key) as {
			value: number;
		} | null;
		if (!row) continue;
		switch (key) {
			case "total_processed":
				stats.totalProcessed = row.value;
				break;
			case "total_confirmed":
				stats.totalConfirmed = row.value;
				break;
			case "total_finalized":
				stats.totalFinalized = row.value;
				break;
			case "total_dead":
				stats.totalDead = row.value;
				break;
			case "total_dropped":
				stats.totalDropped = row.value;
				break;
			case "total_skipped":
				stats.totalSkipped = row.value;
				break;
			case "total_hash_changes":
				stats.totalHashChanges = row.value;
				break;
			case "total_divergences":
				stats.totalDivergences = row.value;
				break;
			case "max_gap_pf":
				stats.maxGapPF = row.value;
				break;
			case "max_consecutive_depth":
				stats.maxConsecutiveDepth = row.value;
				break;
			case "ttr_max_ms":
				stats.ttrMaxMs = row.value;
				break;
			case "confirmed_not_finalized":
				stats.confirmedNotFinalized = row.value;
				break;
		}
	}
}

function loadCursor(): { lastFinalized: bigint; firstMonitored: bigint | null } | null {
	const row = db
		.prepare(
			"SELECT last_finalized_slot, last_run_at, first_monitored_slot FROM cursor WHERE id = 1",
		)
		.get() as {
		last_finalized_slot: number;
		last_run_at: string;
		first_monitored_slot: number | null;
	} | null;
	if (row) {
		console.log(`Resuming from slot ${row.last_finalized_slot} (last run: ${row.last_run_at})`);
		return {
			lastFinalized: BigInt(row.last_finalized_slot),
			firstMonitored: row.first_monitored_slot != null ? BigInt(row.first_monitored_slot) : null,
		};
	}
	return null;
}

let firstMonitoredSlot: bigint | null = null;

function flushToDb(): void {
	if (!upsertStat) return;
	const tx = db.transaction(() => {
		upsertStat.run("total_processed", stats.totalProcessed, stats.totalProcessed);
		upsertStat.run("total_confirmed", stats.totalConfirmed, stats.totalConfirmed);
		upsertStat.run("total_finalized", stats.totalFinalized, stats.totalFinalized);
		upsertStat.run("total_dead", stats.totalDead, stats.totalDead);
		upsertStat.run("total_dropped", stats.totalDropped, stats.totalDropped);
		upsertStat.run("total_skipped", stats.totalSkipped, stats.totalSkipped);
		upsertStat.run("total_hash_changes", stats.totalHashChanges, stats.totalHashChanges);
		upsertStat.run("total_divergences", stats.totalDivergences, stats.totalDivergences);
		upsertStat.run("max_gap_pf", stats.maxGapPF, stats.maxGapPF);
		upsertStat.run("max_consecutive_depth", stats.maxConsecutiveDepth, stats.maxConsecutiveDepth);
		upsertStat.run("ttr_max_ms", stats.ttrMaxMs, stats.ttrMaxMs);
		upsertStat.run(
			"confirmed_not_finalized",
			stats.confirmedNotFinalized,
			stats.confirmedNotFinalized,
		);

		if (pollFinalized != null) {
			db.prepare(
				"INSERT INTO cursor (id, last_finalized_slot, last_run_at, first_monitored_slot) " +
					"VALUES (1, ?, ?, ?) " +
					"ON CONFLICT(id) DO UPDATE SET last_finalized_slot = excluded.last_finalized_slot, " +
					"last_run_at = excluded.last_run_at, " +
					"first_monitored_slot = COALESCE(cursor.first_monitored_slot, excluded.first_monitored_slot)",
			).run(
				Number(pollFinalized),
				new Date().toISOString(),
				firstMonitoredSlot != null ? Number(firstMonitoredSlot) : null,
			);
		}

		// Flush fork events (slot_drop, confirmed_not_finalized)
		const insertFork = db.prepare(
			"INSERT INTO fork_events (slot, detected_at, type, parent_expected, parent_actual, detail) " +
				"VALUES (?, ?, ?, ?, ?, ?)",
		);
		for (const evt of pendingForkEvents) {
			insertFork.run(
				Number(evt.slot),
				new Date(evt.detectedAt).toISOString(),
				evt.type,
				null,
				null,
				evt.detail,
			);
		}
		pendingForkEvents.length = 0;

		// Flush hash change events
		const insertHash = db.prepare(
			"INSERT INTO hash_change_events (slot, provider_index, old_blockhash, new_blockhash, detected_at, consecutive_depth) " +
				"VALUES (?, ?, ?, ?, ?, ?)",
		);
		for (const evt of pendingHashChangeEvents) {
			insertHash.run(
				Number(evt.slot),
				evt.providerIndex,
				evt.oldBlockhash,
				evt.newBlockhash,
				new Date(evt.detectedAt).toISOString(),
				evt.consecutiveDepth,
			);
		}
		pendingHashChangeEvents.length = 0;

		// Flush closed divergence events
		const insertDiv = db.prepare(
			"INSERT INTO divergence_events (slot, started_at, ended_at, duration_ms, provider_hashes, converged_to) " +
				"VALUES (?, ?, ?, ?, ?, ?)",
		);
		for (const div of pendingDivergenceEvents) {
			const hashesJson = JSON.stringify(Object.fromEntries(div.providerHashes));
			const duration = div.endedAt != null ? div.endedAt - div.startedAt : null;
			insertDiv.run(
				Number(div.slot),
				new Date(div.startedAt).toISOString(),
				div.endedAt != null ? new Date(div.endedAt).toISOString() : null,
				duration,
				hashesJson,
				div.convergedTo,
			);
		}
		pendingDivergenceEvents.length = 0;
	});
	tx();
}

// ─── Slot record helpers ────────────────────────────────────────────────────

function getOrCreateSlotHash(slot: bigint): SlotHashRecord {
	let rec = slotMap.get(slot);
	if (!rec) {
		rec = {
			slot,
			observations: new Map(),
			createdAt: Date.now(),
			firstSeenProcessed: null,
			sawConfirmed: false,
			sawFinalized: false,
			finalizedAt: null,
			isDead: false,
			deadReason: null,
			dropCounted: false,
			isGapSlot: false,
			hashChanged: false,
			timeToRootMs: null,
		};
		slotMap.set(slot, rec);
	}
	return rec;
}

function addRecent(label: string, detail: string): void {
	recentEvents.unshift({ time: Date.now(), label, detail });
	if (recentEvents.length > MAX_RECENT) recentEvents.length = MAX_RECENT;
}

// ─── M1: Hash Change detection + M5: Fork Depth ─────────────────────────────

function recordObservation(slot: bigint, providerIdx: number, obs: BlockhashObservation): void {
	const rec = getOrCreateSlotHash(slot);

	let history = rec.observations.get(providerIdx);
	if (!history) {
		history = [];
		rec.observations.set(providerIdx, history);
	}

	// M1: Check if hash changed from previous observation on same provider
	if (history.length > 0) {
		const lastObs = history[history.length - 1];
		if (lastObs.blockhash !== obs.blockhash) {
			stats.totalHashChanges++;
			rec.hashChanged = true;
			const depth = computeConsecutiveDepth(slot);

			pendingHashChangeEvents.push({
				slot,
				providerIndex: providerIdx,
				oldBlockhash: lastObs.blockhash,
				newBlockhash: obs.blockhash,
				detectedAt: Date.now(),
				consecutiveDepth: depth,
			});

			addRecent(
				"HCHG",
				`Slot ${fmt(slot)} hash changed on ${providers[providerIdx].name} (depth: ${depth})`,
			);
		}
	}

	history.push(obs);

	// M2: Cross-provider divergence check
	if (providers.length > 1) {
		analyzeSlot(slot);
	}
}

function computeConsecutiveDepth(slot: bigint): number {
	let depth = 0;
	let s = slot;
	while (s >= 0n) {
		const rec = slotMap.get(s);
		if (!rec || !rec.hashChanged) break;
		depth++;
		s--;
	}

	// Update hourly max
	const hour = new Date().getHours();
	if (hour !== currentHour) {
		currentHour = hour;
		maxDepthThisHour = 0;
	}
	if (depth > maxDepthThisHour) maxDepthThisHour = depth;

	// Update all-time max
	if (depth > stats.maxConsecutiveDepth) {
		stats.maxConsecutiveDepth = depth;
	}

	return depth;
}

// ─── M2: Cross-RPC Divergence ───────────────────────────────────────────────

function analyzeSlot(slot: bigint): void {
	const rec = slotMap.get(slot);
	if (!rec) return;

	// Get latest blockhash from each provider — only if observation is fresh
	const now = Date.now();
	const latestHashes = new Map<number, string>();
	for (const [provIdx, history] of rec.observations) {
		if (history.length > 0) {
			const latest = history[history.length - 1];
			if (now - latest.fetchedAt <= OBS_FRESHNESS_MS) {
				latestHashes.set(provIdx, latest.blockhash);
			}
		}
	}

	// Need at least 2 fresh observations to compare
	if (latestHashes.size < 2) return;

	const uniqueHashes = new Set(latestHashes.values());
	const existing = openDivergences.get(slot);

	if (uniqueHashes.size > 1) {
		// Divergence detected
		if (!existing) {
			const div: DivergenceWindow = {
				slot,
				startedAt: Date.now(),
				endedAt: null,
				providerHashes: new Map(latestHashes),
				convergedTo: null,
			};
			openDivergences.set(slot, div);
			stats.totalDivergences++;
			addRecent("DIV", `Slot ${fmt(slot)} providers disagree on blockhash`);
		} else {
			existing.providerHashes = new Map(latestHashes);
		}
	} else if (existing && existing.endedAt == null) {
		// Was diverged, now converged
		existing.endedAt = Date.now();
		existing.convergedTo = [...uniqueHashes][0];
		const duration = existing.endedAt - existing.startedAt;
		if (duration > maxDivergenceDurationMs) maxDivergenceDurationMs = duration;
		pendingDivergenceEvents.push(existing);
		openDivergences.delete(slot);
	}
}

// ─── Blockhash polling loop ─────────────────────────────────────────────────

function collectUnfinalizedSlots(beforeSlot: bigint): bigint[] {
	const result: bigint[] = [];
	for (const [slot, rec] of slotMap) {
		if (!rec.sawFinalized && !rec.isDead && !rec.dropCounted && slot <= beforeSlot) {
			result.push(slot);
		}
	}
	// Shuffle for random sampling
	for (let i = result.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[result[i], result[j]] = [result[j], result[i]];
	}
	return result;
}

async function fetchBlock(
	providerIdx: number,
	slot: bigint,
): Promise<{ ok: boolean; rateLimited: boolean }> {
	try {
		const block = await providers[providerIdx].rpc
			.getBlock(slot, {
				transactionDetails: "none",
				commitment: "confirmed",
				maxSupportedTransactionVersion: 0,
			})
			.send();
		if (block != null) {
			recordObservation(slot, providerIdx, {
				blockhash: block.blockhash,
				parentSlot: block.parentSlot,
				previousBlockhash: block.previousBlockhash,
				fetchedAt: Date.now(),
			});
		}
		providerHealthMap[providerIdx].lastSuccess = Date.now();
		providerHealthMap[providerIdx].consecutiveErrors = 0;
		return { ok: true, rateLimited: false };
	} catch (err) {
		providerHealthMap[providerIdx].consecutiveErrors++;
		const is429 = String(err).includes("429") || String(err).includes("Too many requests");
		return { ok: false, rateLimited: is429 };
	}
}

async function blockhashPollCycle(): Promise<void> {
	if (pollConfirmed == null) return;

	const currentConfirmed = pollConfirmed;
	const prevPolled = lastPolledConfirmedSlot ?? currentConfirmed;
	const newSlotCount = currentConfirmed > prevPolled ? Number(currentConfirmed - prevPolled) : 0;

	// Build new-slot list (most recent first for priority)
	const newSlots: bigint[] = [];
	for (let i = 0; i < Math.min(newSlotCount, 50); i++) {
		newSlots.push(prevPolled + BigInt(i + 1));
	}

	// Pre-collect re-check candidates (shuffled)
	const recheckSlots = collectUnfinalizedSlots(prevPolled);

	// Per-provider: split adaptive budget 60% new slots, 40% re-checks
	const allFetches: Promise<{ ok: boolean; rateLimited: boolean }>[] = [];
	const providerCycleCounts: Array<{ successes: number; failures429: number }> = providers.map(
		() => ({ successes: 0, failures429: 0 }),
	);

	for (let p = 0; p < providers.length; p++) {
		const budget = rateControllers[p].getTokens();
		const newBudget = Math.ceil(budget * 0.6);
		const recheckBudget = budget - newBudget;

		// Queue new-slot fetches for this provider
		const provNewSlots = newSlots.slice(0, newBudget);
		// Queue re-check fetches for this provider
		const provRecheckSlots = recheckSlots.slice(0, recheckBudget);

		const providerIdx = p;
		for (const slot of provNewSlots) {
			allFetches.push(
				fetchBlock(providerIdx, slot).then((r) => {
					if (r.ok) providerCycleCounts[providerIdx].successes++;
					if (r.rateLimited) providerCycleCounts[providerIdx].failures429++;
					return r;
				}),
			);
		}
		for (const slot of provRecheckSlots) {
			allFetches.push(
				fetchBlock(providerIdx, slot).then((r) => {
					if (r.ok) providerCycleCounts[providerIdx].successes++;
					if (r.rateLimited) providerCycleCounts[providerIdx].failures429++;
					return r;
				}),
			);
		}
	}

	await Promise.all(allFetches);

	// Feed results back to adaptive rate controllers
	for (let p = 0; p < providers.length; p++) {
		const c = providerCycleCounts[p];
		rateControllers[p].reportCycle(c.successes, c.failures429);
	}

	lastPolledConfirmedSlot = currentConfirmed;
}

// ─── Event handlers ─────────────────────────────────────────────────────────

function handleSlotNotification(notification: {
	slot: bigint;
	parent: bigint;
	root: bigint;
}): void {
	lastWsSlotEvent = Date.now();
	const rec = getOrCreateSlotHash(notification.slot);
	if (rec.firstSeenProcessed == null) {
		rec.firstSeenProcessed = Date.now();
		stats.totalProcessed++;
		rateProcessed.record();
	}
	if (notification.slot > lastSeenSlot) {
		// Detect skipped slots — create records so prune cycle can verify via getBlocks
		if (lastSeenSlot > 0n) {
			const gap = notification.slot - lastSeenSlot - 1n;
			if (gap > 0n && gap <= 100n) {
				const gapNum = Number(gap);
				stats.totalSkipped += gapNum;
				for (let i = 0; i < gapNum; i++) rateSkipped.record();
				for (let s = lastSeenSlot + 1n; s < notification.slot; s++) {
					const skipped = getOrCreateSlotHash(s);
					skipped.firstSeenProcessed = Date.now();
					skipped.isGapSlot = true;
				}
			} else if (gap > 100n) {
				stats.totalSkipped += Number(gap);
			}
		}
		lastSeenSlot = notification.slot;
	}
}

function handleSlotUpdate(notification: {
	slot: bigint;
	timestamp: bigint;
	type: string;
	parent?: bigint;
	err?: string;
}): void {
	lastWsUpdateEvent = Date.now();
	const rec = getOrCreateSlotHash(notification.slot);

	switch (notification.type) {
		case "optimisticConfirmation":
			if (!rec.sawConfirmed && rec.firstSeenProcessed != null) {
				rec.sawConfirmed = true;
				stats.totalConfirmed++;
				rateConfirmed.record();
			}
			break;
		case "root":
			if (!rec.sawFinalized && rec.firstSeenProcessed != null) {
				rec.sawFinalized = true;
				rec.finalizedAt = Date.now();
				stats.totalFinalized++;
				rateFinalized.record();
				// M4: Time to Root — skip gap slots (synthetic firstSeenProcessed)
				if (!rec.isGapSlot) {
					const ttr = Date.now() - rec.firstSeenProcessed;
					rec.timeToRootMs = ttr;
					ttrSamples.push(ttr);
					if (ttrSamples.length > TTR_MAX_SAMPLES) ttrSamples.shift();
					if (ttr > stats.ttrMaxMs) stats.ttrMaxMs = ttr;
				}
			}
			break;
		case "dead":
			if (!rec.isDead) {
				rec.isDead = true;
				rec.deadReason = notification.err ?? "unknown";
				stats.totalDead++;
				rateDead.record();
				addRecent("DEAD", `Slot ${fmt(rec.slot)} err: "${rec.deadReason}"`);
			}
			break;
	}
}

// ─── Maintenance (prune + drop detection) ───────────────────────────────────

async function pruneSlotMap(): Promise<void> {
	const now = Date.now();
	const toDelete: bigint[] = [];

	// Collect candidate drops: processed but no WS confirmation after timeout
	const dropCandidates: SlotHashRecord[] = [];
	for (const [, rec] of slotMap) {
		if (
			rec.firstSeenProcessed != null &&
			!rec.sawConfirmed &&
			!rec.isDead &&
			!rec.dropCounted &&
			now - rec.firstSeenProcessed > DROP_TIMEOUT_MS
		) {
			dropCandidates.push(rec);
		}
	}

	// Batch-verify candidates against chain via getBlocks before classifying
	if (dropCandidates.length > 0) {
		const candidateSlots = dropCandidates.map((r) => r.slot).sort();
		const rangeStart = candidateSlots[0];
		const rangeEnd = candidateSlots[candidateSlots.length - 1];
		let confirmedOnChain = new Set<bigint>();
		try {
			const blocks = await rpc.getBlocks(rangeStart, rangeEnd, { commitment: "confirmed" }).send();
			confirmedOnChain = new Set(blocks);
		} catch {
			// If RPC fails, skip drop detection this cycle
		}

		for (const rec of dropCandidates) {
			if (confirmedOnChain.has(rec.slot)) {
				rec.sawConfirmed = true;
				if (!rec.isGapSlot) {
					stats.totalConfirmed++;
					rateConfirmed.record();
				}
			} else {
				rec.dropCounted = true;
				stats.totalDropped++;
				rateDropped.record();
				const evt: ForkEvent = {
					slot: rec.slot,
					detectedAt: now,
					type: "slot_drop",
					detail: `Slot ${rec.slot} processed but not confirmed on chain after ${DROP_TIMEOUT_MS / 1000}s`,
				};
				pendingForkEvents.push(evt);
				addRecent("DROP", `Slot ${fmt(rec.slot)} never confirmed`);
			}
		}
	}

	for (const [slot, rec] of slotMap) {
		const age = now - rec.createdAt;

		// Confirmed but never finalized (after finalize window)
		if (rec.sawConfirmed && !rec.sawFinalized && !rec.isDead && age > PRUNE_FINALIZED_AGE_MS) {
			stats.confirmedNotFinalized++;
			const evt: ForkEvent = {
				slot: rec.slot,
				detectedAt: now,
				type: "confirmed_not_finalized",
				detail: `Slot ${rec.slot} confirmed but not finalized after ${PRUNE_FINALIZED_AGE_MS / 1000}s`,
			};
			pendingForkEvents.push(evt);
			addRecent("CFNF", `Slot ${fmt(rec.slot)} confirmed but not finalized`);
			toDelete.push(slot);
			continue;
		}

		// Prune old finalized/dead records
		if ((rec.sawFinalized || rec.isDead) && age > PRUNE_FINALIZED_AGE_MS) {
			toDelete.push(slot);
		}
		// Prune old dropped records
		if (rec.dropCounted && age > PRUNE_DROPPED_AGE_MS) {
			toDelete.push(slot);
		}
	}

	for (const slot of toDelete) {
		slotMap.delete(slot);
		// Close any open divergence for pruned slots — don't count in max duration
		// (duration would reflect prune age, not real convergence time)
		const div = openDivergences.get(slot);
		if (div && div.endedAt == null) {
			div.endedAt = now;
			div.convergedTo = "pruned";
			pendingDivergenceEvents.push(div);
			openDivergences.delete(slot);
		}
	}

	flushToDb();
}

// ─── Polling cross-check (M3: Gap tracking) ─────────────────────────────────

async function pollCommitmentLevels(): Promise<void> {
	try {
		const [processed, confirmed, finalized] = await Promise.all([
			rpc.getSlot({ commitment: "processed" }).send(),
			rpc.getSlot({ commitment: "confirmed" }).send(),
			rpc.getSlot({ commitment: "finalized" }).send(),
		]);
		pollProcessed = processed;
		pollConfirmed = confirmed;
		pollFinalized = finalized;
		lastPollSuccess = Date.now();

		// M3: Track gap
		const gap = Number(processed - finalized);
		gapPfSamples.push(gap);
		if (gapPfSamples.length > GAP_TREND_WINDOW * 2) {
			gapPfSamples.splice(0, gapPfSamples.length - GAP_TREND_WINDOW * 2);
		}
		if (gap > stats.maxGapPF) stats.maxGapPF = gap;
	} catch {
		// Polling failure is non-fatal; dashboard will show stale data
	}
}

function computeGapTrend(): string {
	if (gapPfSamples.length < GAP_TREND_WINDOW) return "collecting";
	const window = gapPfSamples.slice(-GAP_TREND_WINDOW);
	const first3Avg = (window[0] + window[1] + window[2]) / 3;
	const last3Avg =
		(window[window.length - 3] + window[window.length - 2] + window[window.length - 1]) / 3;
	const diff = last3Avg - first3Avg;
	if (diff > 2) return "widening";
	if (diff < -2) return "narrowing";
	return "stable";
}

// ─── Dashboard ──────────────────────────────────────────────────────────────

function fmt(n: bigint): string {
	return Number(n).toLocaleString();
}

function fmtNum(n: number): string {
	return n.toLocaleString();
}

function fmtRate(r: number): string {
	if (r < 0.01) return r.toFixed(4);
	return r.toFixed(2);
}

function fmtMs(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function elapsed(): string {
	const ms = Date.now() - startTime;
	const s = Math.floor(ms / 1000) % 60;
	const m = Math.floor(ms / 60000) % 60;
	const h = Math.floor(ms / 3600000);
	return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
}

function computePercentiles(samples: number[]): {
	avg: number;
	p50: number;
	p95: number;
	max: number;
} {
	if (samples.length === 0) return { avg: 0, p50: 0, p95: 0, max: 0 };
	const sorted = [...samples].sort((a, b) => a - b);
	const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
	const p50 = sorted[Math.floor(sorted.length * 0.5)];
	const p95 = sorted[Math.floor(sorted.length * 0.95)];
	const max = sorted[sorted.length - 1];
	return { avg, p50, p95, max };
}

function formatDashboard(): string {
	const W = 75;
	const bar = "=".repeat(W);
	const p = pollProcessed ?? 0n;
	const c = pollConfirmed ?? 0n;
	const f = pollFinalized ?? 0n;
	const gapPF = pollProcessed != null ? Number(p - f) : 0;
	const trend = computeGapTrend();
	const ttr = computePercentiles(ttrSamples);

	const lines: string[] = [
		bar,
		`  SOLANA FORK MONITOR    ${cluster}    ${elapsed()}    Providers: ${providers.length}`,
		bar,
		`  COMMITMENT    Processed: ${fmt(p)}  Confirmed: ${fmt(c)}  Finalized: ${fmt(f)}`,
		"",
		"  FORK METRICS",
		`  M1 Hash Changes:   ${fmtNum(stats.totalHashChanges)} events   max depth: ${stats.maxConsecutiveDepth}`,
		`  M2 Cross-RPC Div:  ${fmtNum(stats.totalDivergences)} events   open: ${openDivergences.size}   max duration: ${maxDivergenceDurationMs > 0 ? fmtMs(maxDivergenceDurationMs) : "---"}`,
		`  M3 P->F Gap:       ${gapPF} (max: ${stats.maxGapPF}) [${trend}]`,
		ttrSamples.length > 0
			? `  M4 Time to Root:   avg ${fmtMs(ttr.avg)}  p50 ${fmtMs(ttr.p50)}  p95 ${fmtMs(ttr.p95)}  max ${fmtMs(ttr.max)}`
			: "  M4 Time to Root:   avg ---  p50 ---  p95 ---  max ---",
		`  M5 Max Fork Depth: ${maxDepthThisHour} this hour`,
		"",
		"  LIFECYCLE           COUNT      RATE",
		`  Processed     ${fmtNum(stats.totalProcessed).padStart(10)}    ${fmtRate(rateProcessed.rate()).padStart(7)}/s`,
		`  Confirmed     ${fmtNum(stats.totalConfirmed).padStart(10)}    ${fmtRate(rateConfirmed.rate()).padStart(7)}/s`,
		`  Finalized     ${fmtNum(stats.totalFinalized).padStart(10)}    ${fmtRate(rateFinalized.rate()).padStart(7)}/s`,
		`  Dead          ${fmtNum(stats.totalDead).padStart(10)}    ${fmtRate(rateDead.rate()).padStart(7)}/s`,
		`  Dropped       ${fmtNum(stats.totalDropped).padStart(10)}    ${fmtRate(rateDropped.rate()).padStart(7)}/s`,
		`  Skipped       ${fmtNum(stats.totalSkipped).padStart(10)}    ${fmtRate(rateSkipped.rate()).padStart(7)}/s`,
		"",
		"  RECENT",
	];

	if (recentEvents.length === 0) {
		lines.push("  (none yet)");
	} else {
		for (const evt of recentEvents) {
			const t = new Date(evt.time).toLocaleTimeString("en-GB", { hour12: false });
			lines.push(`  ${t}  ${evt.label.padEnd(5)} ${evt.detail}`);
		}
	}

	// Health line
	const now = Date.now();
	const STALE_THRESHOLD_MS = 30_000;
	const agePoll = lastPollSuccess ? Math.floor((now - lastPollSuccess) / 1000) : -1;
	const ageWsSlot = lastWsSlotEvent ? Math.floor((now - lastWsSlotEvent) / 1000) : -1;
	const ageWsUpdate = lastWsUpdateEvent ? Math.floor((now - lastWsUpdateEvent) / 1000) : -1;
	const fmtAge = (age: number) => (age < 0 ? "waiting" : `${age}s ago`);
	const stale =
		(lastPollSuccess > 0 && now - lastPollSuccess > STALE_THRESHOLD_MS) ||
		(lastWsSlotEvent > 0 && now - lastWsSlotEvent > STALE_THRESHOLD_MS) ||
		(lastWsUpdateEvent > 0 && now - lastWsUpdateEvent > STALE_THRESHOLD_MS);

	lines.push("");
	lines.push(
		`  HEALTH: Poll ${fmtAge(agePoll)} | WS-slot ${fmtAge(ageWsSlot)} | WS-update ${fmtAge(ageWsUpdate)}`,
	);

	// Provider health with adaptive rate info
	const provParts = providers.map((prov, i) => {
		const h = providerHealthMap[i];
		const rc = rateControllers[i];
		const status = h.consecutiveErrors > 3 ? "ERR" : h.lastSuccess > 0 ? "ok" : "waiting";
		const tokens = rc.getTokens();
		const errs = rc.total429s > 0 ? ` 429s:${rc.total429s}` : "";
		return `${prov.name} [${status}] ${tokens}t/c${errs}`;
	});
	lines.push(`  PROVIDERS: ${provParts.join(" | ")}${stale ? "  !! STALE" : ""}`);
	lines.push(bar);

	return lines.join("\n");
}

function renderDashboard(): void {
	process.stdout.write("\x1B[2J\x1B[H");
	process.stdout.write(formatDashboard());
	process.stdout.write("\n");
}

// ─── WebSocket reconnection wrapper ─────────────────────────────────────────

async function runWithReconnect(
	name: string,
	fn: (signal: AbortSignal) => Promise<void>,
	outerSignal: AbortSignal,
	onReconnect?: () => void,
): Promise<void> {
	while (!outerSignal.aborted) {
		const inner = new AbortController();
		const onAbort = () => inner.abort();
		outerSignal.addEventListener("abort", onAbort, { once: true });

		try {
			await fn(inner.signal);
		} catch (err) {
			if (outerSignal.aborted) return;
			onReconnect?.();
			console.error(
				`[${name}] disconnected: ${err}. Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`,
			);
			await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));
		} finally {
			outerSignal.removeEventListener("abort", onAbort);
		}
	}
}

// ─── Verification / backtest ─────────────────────────────────────────────────

const GETBLOCKS_MAX_RANGE = 500_000n;

async function fetchBlocksInRange(
	start: bigint,
	end: bigint,
	commitment: "confirmed" | "finalized",
): Promise<Set<bigint>> {
	const allSlots = new Set<bigint>();
	let cursor = start;
	while (cursor <= end) {
		const batchEnd =
			cursor + GETBLOCKS_MAX_RANGE - 1n < end ? cursor + GETBLOCKS_MAX_RANGE - 1n : end;
		const slots = await rpc.getBlocks(cursor, batchEnd, { commitment }).send();
		for (const s of slots) allSlots.add(s);
		cursor = batchEnd + 1n;
	}
	return allSlots;
}

async function runVerification(): Promise<void> {
	console.log(`\nVERIFICATION MODE — Cluster: ${cluster}`);
	console.log(`DB: ${dbPath}\n`);

	const cursor = loadCursor();
	if (!cursor || cursor.firstMonitored == null) {
		console.error("No monitoring range found in DB. Run the monitor first, then use --verify.");
		db.close();
		process.exit(1);
	}

	const rangeStart = cursor.firstMonitored;
	const rangeEnd = cursor.lastFinalized;
	const totalSlotsInRange = Number(rangeEnd - rangeStart) + 1;

	console.log(`Monitored range: ${fmt(rangeStart)} -> ${fmt(rangeEnd)}`);
	console.log(`Total slots in range: ${fmtNum(totalSlotsInRange)}\n`);

	loadPersistedStats();
	const dbForkEvents = db.prepare("SELECT slot, type, detail FROM fork_events").all() as Array<{
		slot: number;
		type: string;
		detail: string;
	}>;
	const dbDeadSlots = new Set(
		dbForkEvents.filter((e) => e.type === "slot_drop").map((e) => e.slot),
	);

	// Load hash change and divergence events for display
	const dbHashChanges = db.prepare("SELECT COUNT(*) as count FROM hash_change_events").get() as {
		count: number;
	} | null;
	const dbDivergences = db.prepare("SELECT COUNT(*) as count FROM divergence_events").get() as {
		count: number;
	} | null;

	console.log("--- Step 1: getBlocks (confirmed vs finalized) ---");
	console.log("Fetching confirmed blocks in range...");
	const confirmedSlots = await fetchBlocksInRange(rangeStart, rangeEnd, "confirmed");
	console.log("Fetching finalized blocks in range...");
	const finalizedSlots = await fetchBlocksInRange(rangeStart, rangeEnd, "finalized");

	const missingFromConfirmed = totalSlotsInRange - confirmedSlots.size;
	const confirmedNotFinalized = confirmedSlots.size - finalizedSlots.size;

	console.log(`  Confirmed blocks: ${fmtNum(confirmedSlots.size)}`);
	console.log(`  Finalized blocks: ${fmtNum(finalizedSlots.size)}`);
	console.log(`  Missing from confirmed (skipped/dead): ${fmtNum(missingFromConfirmed)}`);
	console.log(`  Confirmed but not finalized: ${fmtNum(confirmedNotFinalized)}`);

	const missingSlots: bigint[] = [];
	for (let s = rangeStart; s <= rangeEnd; s++) {
		if (!confirmedSlots.has(s)) missingSlots.push(s);
	}

	console.log("\n--- Step 2: getBlockProduction ---");
	console.log("Fetching block production for range...");
	let bpLeaderSlots = 0n;
	let bpBlocksProduced = 0n;
	try {
		const bp = await rpc
			.getBlockProduction({
				range: { firstSlot: rangeStart, lastSlot: rangeEnd },
			})
			.send();
		for (const [leaderSlots, blocksProduced] of Object.values(bp.value.byIdentity)) {
			bpLeaderSlots += leaderSlots;
			bpBlocksProduced += blocksProduced;
		}
		console.log(`  Leader slots: ${fmt(bpLeaderSlots)}`);
		console.log(`  Blocks produced: ${fmt(bpBlocksProduced)}`);
		console.log(`  Skipped by leaders: ${fmt(bpLeaderSlots - bpBlocksProduced)}`);
		const skipRate = (Number(bpLeaderSlots - bpBlocksProduced) / Number(bpLeaderSlots)) * 100;
		console.log(`  Skip rate: ${skipRate.toFixed(2)}%`);
	} catch (err) {
		console.log(`  (getBlockProduction failed: ${err} — range may be too old)`);
	}

	console.log("\n--- Step 3: Reconciliation ---");

	const ourDeadDropped = stats.totalDead + stats.totalDropped;
	const chainMissing = missingSlots.length;

	console.log("  Monitor recorded:");
	console.log(`    Dead:    ${fmtNum(stats.totalDead)}`);
	console.log(`    Dropped: ${fmtNum(stats.totalDropped)}`);
	console.log(`    Dead + Dropped: ${fmtNum(ourDeadDropped)}`);
	console.log(`    Skipped (WS gaps, unreliable): ${fmtNum(stats.totalSkipped)}`);
	console.log("  Chain reports:");
	console.log(`    Missing from confirmed: ${fmtNum(chainMissing)}`);

	const diff = chainMissing - ourDeadDropped;
	if (diff === 0) {
		console.log("\n  MATCH — Monitor dead+dropped count matches chain exactly.");
	} else if (diff > 0) {
		console.log(
			`\n  DISCREPANCY — Chain has ${fmtNum(diff)} more missing slots than monitor recorded.`,
		);
		console.log(
			"  Possible causes: WS reconnection gap, late subscription start, pruned before detection.",
		);
	} else {
		console.log(
			`\n  DISCREPANCY — Monitor recorded ${fmtNum(-diff)} more dead+dropped than chain shows missing.`,
		);
		console.log(
			"  Possible causes: slots confirmed after we classified them as dropped (timeout too short).",
		);
	}

	if (dbDeadSlots.size > 0) {
		let matchCount = 0;
		let falsePositives = 0;
		for (const slot of dbDeadSlots) {
			if (!confirmedSlots.has(BigInt(slot))) matchCount++;
			else falsePositives++;
		}
		console.log(
			`\n  Drop event accuracy: ${matchCount}/${dbDeadSlots.size} confirmed missing on chain`,
		);
		if (falsePositives > 0) {
			console.log(`  False positives: ${falsePositives} (we said dropped, chain says confirmed)`);
		}
	}

	// Show fork metric stats
	console.log("\n--- Step 4: Fork Metrics Summary ---");
	console.log(
		`  Hash changes (M1): ${fmtNum(stats.totalHashChanges)} (DB: ${dbHashChanges?.count ?? 0})`,
	);
	console.log(
		`  Cross-RPC divergences (M2): ${fmtNum(stats.totalDivergences)} (DB: ${dbDivergences?.count ?? 0})`,
	);
	console.log(`  Max P->F gap (M3): ${stats.maxGapPF}`);
	console.log(`  Max consecutive depth (M5): ${stats.maxConsecutiveDepth}`);
	console.log(`  Time to root max (M4): ${stats.ttrMaxMs > 0 ? fmtMs(stats.ttrMaxMs) : "---"}`);

	if (missingSlots.length > 0) {
		const show = missingSlots.slice(0, 20);
		console.log(
			`\n  Sample missing slots (first ${show.length} of ${fmtNum(missingSlots.length)}):`,
		);
		console.log(`    ${show.map((s) => fmt(s)).join(", ")}`);
	}

	console.log("\n--- Done ---\n");
	db.close();
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	if (VERIFY_MODE) {
		await runVerification();
		return;
	}

	loadPersistedStats();
	const cursor = loadCursor();
	if (cursor != null) {
		pollFinalized = cursor.lastFinalized;
		firstMonitoredSlot = cursor.firstMonitored;
	}

	console.log(`Solana Fork Monitor starting on ${cluster}`);
	console.log(`Providers: ${providers.length}`);
	for (const prov of providers) {
		console.log(`  ${prov.name}: ${prov.rpcUrl}`);
		console.log(`    WS: ${prov.wsUrl}`);
	}
	console.log(`DB: ${dbPath}`);

	// Initial poll — must succeed to establish baseline
	await pollCommitmentLevels();
	if (pollFinalized == null) {
		console.error("Failed to fetch initial slot from RPC. Check your connection and cluster.");
		db.close();
		process.exit(1);
	}
	if (firstMonitoredSlot === null) firstMonitoredSlot = pollFinalized;
	console.log(`Current finalized slot: ${fmt(pollFinalized)}`);

	const outerAc = new AbortController();

	// WS subscriptions run on providers[0] only
	const stableWs = createSolanaRpcSubscriptions(providers[0].wsUrl);
	runWithReconnect(
		"slotNotifications",
		async (signal) => {
			const sub = await stableWs.slotNotifications().subscribe({ abortSignal: signal });
			for await (const notification of sub) {
				handleSlotNotification(notification);
			}
		},
		outerAc.signal,
		() => wsSlotReconnects++,
	);

	const unstableWs = createSolanaRpcSubscriptions_UNSTABLE(providers[0].wsUrl);
	runWithReconnect(
		"slotsUpdatesNotifications",
		async (signal) => {
			const sub = await unstableWs.slotsUpdatesNotifications().subscribe({ abortSignal: signal });
			for await (const notification of sub) {
				// biome-ignore lint/suspicious/noExplicitAny: unstable API types may not fully match
				handleSlotUpdate(notification as any);
			}
		},
		outerAc.signal,
		() => wsUpdateReconnects++,
	);

	// Periodic tasks
	const pollTimer = setInterval(async () => {
		await pollCommitmentLevels();
		await blockhashPollCycle();
		await pruneSlotMap();
	}, POLL_INTERVAL_MS);

	const dashTimer = setInterval(() => {
		renderDashboard();
	}, DASHBOARD_INTERVAL_MS);

	// Graceful shutdown
	let shuttingDown = false;
	const shutdown = async () => {
		if (shuttingDown) return;
		shuttingDown = true;

		console.log("\nShutting down...");
		clearInterval(pollTimer);
		clearInterval(dashTimer);
		outerAc.abort();

		// Final flush
		flushToDb();

		// JSON export
		const p = pollProcessed ?? 0n;
		const c = pollConfirmed ?? 0n;
		const f = pollFinalized ?? 0n;
		const ttr = computePercentiles(ttrSamples);
		const summary = {
			cluster,
			runDuration: elapsed(),
			providers: providers.map((prov) => prov.name),
			stats: { ...stats },
			pollSlots: {
				processed: Number(p),
				confirmed: Number(c),
				finalized: Number(f),
			},
			gaps: {
				processedToFinalized: Number(p - f),
				trend: computeGapTrend(),
			},
			forkMetrics: {
				hashChanges: stats.totalHashChanges,
				crossRpcDivergences: stats.totalDivergences,
				openDivergences: openDivergences.size,
				maxConsecutiveDepth: stats.maxConsecutiveDepth,
				maxGapPF: stats.maxGapPF,
				ttr:
					ttrSamples.length > 0
						? { avgMs: ttr.avg, p50Ms: ttr.p50, p95Ms: ttr.p95, maxMs: ttr.max }
						: null,
			},
			recentEvents: recentEvents.map((e) => ({
				time: new Date(e.time).toISOString(),
				label: e.label,
				detail: e.detail,
			})),
		};
		const jsonPath = `reorg-summary-${cluster}-${Date.now()}.json`;
		await Bun.write(jsonPath, JSON.stringify(summary, null, 2));
		console.log(`Summary exported to ${jsonPath}`);

		db.close();
		process.exit(0);
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	console.log("Subscriptions active. Press Ctrl+C to stop.\n");
}

main().catch((err) => {
	console.error("Fatal:", err);
	db.close();
	process.exit(1);
});
