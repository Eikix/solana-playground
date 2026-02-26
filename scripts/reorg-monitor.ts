/**
 * Solana Reorg/Fork Statistics Monitor
 *
 * Tracks slot lifecycles across commitment levels, detects fork switches
 * via parent-lineage divergence, and accumulates statistics over time.
 *
 * Usage:
 *   SOLANA_CLUSTER=mainnet-beta bun run monitor
 *   SOLANA_CLUSTER=devnet bun run monitor
 *   SOLANA_CLUSTER=devnet bun run monitor --verify   # backtest last run against chain
 *   SOLANA_CLUSTER=devnet bun run monitor --reset   # clear stats and start fresh
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

// ─── Constants ──────────────────────────────────────────────────────────────

const DROP_TIMEOUT_MS = 30_000;
const PRUNE_FINALIZED_AGE_MS = 120_000;
const PRUNE_DROPPED_AGE_MS = 60_000;
const POLL_INTERVAL_MS = 5_000;
const DASHBOARD_INTERVAL_MS = 2_000;
const RECONNECT_DELAY_MS = 2_000;

// ─── Types ──────────────────────────────────────────────────────────────────

interface SlotRecord {
	slot: bigint;
	parentFromSlotSubscribe: bigint | null;
	parentFromCreatedBank: bigint | null;
	events: Array<{ type: string; timestamp: bigint; localTime: number }>;
	firstSeen: number;
	sawProcessed: boolean;
	sawConfirmed: boolean;
	sawFinalized: boolean;
	isDead: boolean;
	deadReason: string | null;
	dropCounted: boolean;
	isGapSlot: boolean;
}

interface ForkEvent {
	slot: bigint;
	detectedAt: number;
	type: "parent_mismatch" | "slot_drop" | "confirmed_not_finalized";
	parentExpected: bigint | null;
	parentActual: bigint | null;
	detail: string;
}

interface SessionStats {
	totalProcessed: number;
	totalConfirmed: number;
	totalFinalized: number;
	totalDead: number;
	totalDropped: number;
	totalParentMismatches: number;
	confirmedNotFinalized: number;
	totalSkipped: number;
}

// ─── State ──────────────────────────────────────────────────────────────────

const slotMap = new Map<bigint, SlotRecord>();
const pendingForkEvents: ForkEvent[] = [];
const recentEvents: Array<{ time: number; label: string; detail: string }> = [];
const MAX_RECENT = 5;

const stats: SessionStats = {
	totalProcessed: 0,
	totalConfirmed: 0,
	totalFinalized: 0,
	totalDead: 0,
	totalDropped: 0,
	totalParentMismatches: 0,
	confirmedNotFinalized: 0,
	totalSkipped: 0,
};

let pollProcessed: bigint | null = null;
let pollConfirmed: bigint | null = null;
let pollFinalized: bigint | null = null;
let lastSeenSlot: bigint = 0n;
const startTime = Date.now();

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
		// Binary search for first entry within window
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
	`);

	// Migration: add first_monitored_slot column if missing
	const cols = db.prepare("PRAGMA table_info(cursor)").all() as Array<{ name: string }>;
	if (!cols.some((c) => c.name === "first_monitored_slot")) {
		db.exec("ALTER TABLE cursor ADD COLUMN first_monitored_slot INTEGER");
	}
}

if (RESET_MODE) {
	db.exec("DELETE FROM stats; DELETE FROM cursor; DELETE FROM fork_events;");
	console.log(`Reset: cleared all data in ${dbPath}`);
}

const STAT_KEYS = [
	"total_processed",
	"total_confirmed",
	"total_finalized",
	"total_dead",
	"total_dropped",
	"total_parent_mismatches",
	"confirmed_not_finalized",
	"total_skipped",
] as const;

// Initialize missing stat rows (skip in verify mode — DB is readonly)
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

// Load persisted stats into session
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
			case "total_parent_mismatches":
				stats.totalParentMismatches = row.value;
				break;
			case "confirmed_not_finalized":
				stats.confirmedNotFinalized = row.value;
				break;
			case "total_skipped":
				stats.totalSkipped = row.value;
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
	if (!upsertStat) return; // readonly / verify mode
	const tx = db.transaction(() => {
		upsertStat.run("total_processed", stats.totalProcessed, stats.totalProcessed);
		upsertStat.run("total_confirmed", stats.totalConfirmed, stats.totalConfirmed);
		upsertStat.run("total_finalized", stats.totalFinalized, stats.totalFinalized);
		upsertStat.run("total_dead", stats.totalDead, stats.totalDead);
		upsertStat.run("total_dropped", stats.totalDropped, stats.totalDropped);
		upsertStat.run(
			"total_parent_mismatches",
			stats.totalParentMismatches,
			stats.totalParentMismatches,
		);
		upsertStat.run(
			"confirmed_not_finalized",
			stats.confirmedNotFinalized,
			stats.confirmedNotFinalized,
		);
		upsertStat.run("total_skipped", stats.totalSkipped, stats.totalSkipped);

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

		const insertEvt = db.prepare(
			"INSERT INTO fork_events (slot, detected_at, type, parent_expected, parent_actual, detail) " +
				"VALUES (?, ?, ?, ?, ?, ?)",
		);
		for (const evt of pendingForkEvents) {
			insertEvt.run(
				Number(evt.slot),
				new Date(evt.detectedAt).toISOString(),
				evt.type,
				evt.parentExpected != null ? Number(evt.parentExpected) : null,
				evt.parentActual != null ? Number(evt.parentActual) : null,
				evt.detail,
			);
		}
		pendingForkEvents.length = 0;
	});
	tx();
}

// ─── Slot record helpers ────────────────────────────────────────────────────

function getOrCreateSlot(slot: bigint): SlotRecord {
	let rec = slotMap.get(slot);
	if (!rec) {
		rec = {
			slot,
			parentFromSlotSubscribe: null,
			parentFromCreatedBank: null,
			events: [],
			firstSeen: Date.now(),
			sawProcessed: false,
			sawConfirmed: false,
			sawFinalized: false,
			isDead: false,
			deadReason: null,
			dropCounted: false,
			isGapSlot: false,
		};
		slotMap.set(slot, rec);
	}
	return rec;
}

function checkParentLineage(rec: SlotRecord): void {
	if (
		rec.parentFromSlotSubscribe != null &&
		rec.parentFromCreatedBank != null &&
		rec.parentFromSlotSubscribe !== rec.parentFromCreatedBank
	) {
		stats.totalParentMismatches++;
		const evt: ForkEvent = {
			slot: rec.slot,
			detectedAt: Date.now(),
			type: "parent_mismatch",
			parentExpected: rec.parentFromSlotSubscribe,
			parentActual: rec.parentFromCreatedBank,
			detail:
				`Parent mismatch: slotSubscribe=${rec.parentFromSlotSubscribe}, ` +
				`createdBank=${rec.parentFromCreatedBank}`,
		};
		pendingForkEvents.push(evt);
		addRecent(
			"FORK",
			`Slot ${fmt(rec.slot)} parent: expected ${fmt(rec.parentFromSlotSubscribe)}, got ${fmt(rec.parentFromCreatedBank)}`,
		);
	}
}

function addRecent(label: string, detail: string): void {
	recentEvents.unshift({ time: Date.now(), label, detail });
	if (recentEvents.length > MAX_RECENT) recentEvents.length = MAX_RECENT;
}

// ─── Event handlers ─────────────────────────────────────────────────────────

function handleSlotNotification(notification: {
	slot: bigint;
	parent: bigint;
	root: bigint;
}): void {
	const rec = getOrCreateSlot(notification.slot);
	if (!rec.sawProcessed) {
		rec.sawProcessed = true;
		stats.totalProcessed++;
		rateProcessed.record();
	}
	rec.parentFromSlotSubscribe = notification.parent;
	if (notification.slot > lastSeenSlot) {
		// Detect skipped slots — create records so prune cycle can verify via getBlocks
		if (lastSeenSlot > 0n) {
			const gap = notification.slot - lastSeenSlot - 1n;
			if (gap > 0n && gap <= 100n) {
				// Cap at 100 to avoid flooding on reconnection gaps
				const gapNum = Number(gap);
				stats.totalSkipped += gapNum;
				for (let i = 0; i < gapNum; i++) rateSkipped.record();
				for (let s = lastSeenSlot + 1n; s < notification.slot; s++) {
					const skipped = getOrCreateSlot(s);
					skipped.sawProcessed = true;
					skipped.isGapSlot = true;
				}
			} else if (gap > 100n) {
				// Large gap likely from WS reconnection, just count
				stats.totalSkipped += Number(gap);
			}
		}
		lastSeenSlot = notification.slot;
	}
	checkParentLineage(rec);
}

function handleSlotUpdate(notification: {
	slot: bigint;
	timestamp: bigint;
	type: string;
	parent?: bigint;
	err?: string;
	stats?: {
		numSuccessfulTransactions: bigint;
		numFailedTransactions: bigint;
		numTransactionEntries: bigint;
		maxTransactionsPerEntry: bigint;
	};
}): void {
	const rec = getOrCreateSlot(notification.slot);
	rec.events.push({
		type: notification.type,
		timestamp: notification.timestamp,
		localTime: Date.now(),
	});

	switch (notification.type) {
		case "createdBank":
			if (notification.parent != null) {
				rec.parentFromCreatedBank = notification.parent;
				checkParentLineage(rec);
			}
			break;
		case "optimisticConfirmation":
			if (!rec.sawConfirmed && rec.sawProcessed) {
				rec.sawConfirmed = true;
				stats.totalConfirmed++;
				rateConfirmed.record();
			}
			break;
		case "root":
			if (!rec.sawFinalized && rec.sawProcessed) {
				rec.sawFinalized = true;
				stats.totalFinalized++;
				rateFinalized.record();
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
	const dropCandidates: SlotRecord[] = [];
	for (const [, rec] of slotMap) {
		const age = now - rec.firstSeen;
		if (
			rec.sawProcessed &&
			!rec.sawConfirmed &&
			!rec.isDead &&
			!rec.dropCounted &&
			age > DROP_TIMEOUT_MS
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
			// If RPC fails, skip drop detection this cycle rather than create false positives
		}

		for (const rec of dropCandidates) {
			if (confirmedOnChain.has(rec.slot)) {
				// Chain confirmed this slot — WS event was missed or it was a gap slot
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
					parentExpected: rec.parentFromSlotSubscribe,
					parentActual: null,
					detail: `Slot ${rec.slot} processed but not confirmed on chain after ${DROP_TIMEOUT_MS / 1000}s`,
				};
				pendingForkEvents.push(evt);
				addRecent("DROP", `Slot ${fmt(rec.slot)} never confirmed`);
			}
		}
	}

	for (const [slot, rec] of slotMap) {
		const age = now - rec.firstSeen;

		// Confirmed but never finalized (after finalize window)
		if (rec.sawConfirmed && !rec.sawFinalized && !rec.isDead && age > PRUNE_FINALIZED_AGE_MS) {
			stats.confirmedNotFinalized++;
			const evt: ForkEvent = {
				slot: rec.slot,
				detectedAt: now,
				type: "confirmed_not_finalized",
				parentExpected: null,
				parentActual: null,
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

	for (const slot of toDelete) slotMap.delete(slot);
	flushToDb();
}

// ─── Polling cross-check ────────────────────────────────────────────────────

const rpc = createSolanaRpc(CLUSTER_URLS[cluster]);

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
	} catch {
		// Polling failure is non-fatal; dashboard will show stale data
	}
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

function elapsed(): string {
	const ms = Date.now() - startTime;
	const s = Math.floor(ms / 1000) % 60;
	const m = Math.floor(ms / 60000) % 60;
	const h = Math.floor(ms / 3600000);
	return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
}

function pct(part: number, total: number): string {
	if (total === 0) return "---";
	return `${((part / total) * 100).toFixed(2)}%`;
}

function formatDashboard(): string {
	const W = 65;
	const bar = "=".repeat(W);
	const p = pollProcessed ?? 0n;
	const c = pollConfirmed ?? 0n;
	const f = pollFinalized ?? 0n;
	const gapPC = pollProcessed != null ? Number(p - c) : 0;
	const gapCF = pollConfirmed != null ? Number(c - f) : 0;

	const lines: string[] = [
		bar,
		`  SOLANA REORG MONITOR    Cluster: ${cluster}    ${elapsed()}`,
		bar,
		`  Processed: ${fmt(p)}   Confirmed: ${fmt(c)}   Finalized: ${fmt(f)}`,
		`  Gaps: proc→conf: ${gapPC}      conf→final: ${gapCF}`,
		"",
		"  LIFECYCLE          COUNT       RATE (/s)    SESSION %",
		`  Processed    ${fmtNum(stats.totalProcessed).padStart(10)}    ${fmtRate(rateProcessed.rate()).padStart(9)}    ---`,
		`  Confirmed    ${fmtNum(stats.totalConfirmed).padStart(10)}    ${fmtRate(rateConfirmed.rate()).padStart(9)}    ${pct(stats.totalConfirmed, stats.totalProcessed).padStart(8)}`,
		`  Finalized    ${fmtNum(stats.totalFinalized).padStart(10)}    ${fmtRate(rateFinalized.rate()).padStart(9)}    ${pct(stats.totalFinalized, stats.totalProcessed).padStart(8)}`,
		`  Dead         ${fmtNum(stats.totalDead).padStart(10)}    ${fmtRate(rateDead.rate()).padStart(9)}    ${pct(stats.totalDead, stats.totalProcessed).padStart(8)}`,
		`  Dropped      ${fmtNum(stats.totalDropped).padStart(10)}    ${fmtRate(rateDropped.rate()).padStart(9)}    ${pct(stats.totalDropped, stats.totalProcessed).padStart(8)}`,
		`  Skipped      ${fmtNum(stats.totalSkipped).padStart(10)}    ${fmtRate(rateSkipped.rate()).padStart(9)}    ---`,
		"",
		`  FORK EVENTS: ${stats.totalParentMismatches} parent mismatches | ${stats.totalDropped} drops | ${stats.confirmedNotFinalized} conf-not-final`,
		"",
		"  RECENT (last 5)",
	];

	if (recentEvents.length === 0) {
		lines.push("  (none yet)");
	} else {
		for (const evt of recentEvents) {
			const t = new Date(evt.time).toLocaleTimeString("en-GB", { hour12: false });
			lines.push(`  ${t}  ${evt.label.padEnd(5)} ${evt.detail}`);
		}
	}

	lines.push("");
	lines.push(`  DB: ${dbPath} | Tracked: ${slotMap.size} slots`);
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
): Promise<void> {
	while (!outerSignal.aborted) {
		const inner = new AbortController();
		const onAbort = () => inner.abort();
		outerSignal.addEventListener("abort", onAbort, { once: true });

		try {
			await fn(inner.signal);
		} catch (err) {
			if (outerSignal.aborted) return;
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

	// Load range from DB
	const cursor = loadCursor();
	if (!cursor || cursor.firstMonitored == null) {
		console.error("No monitoring range found in DB. Run the monitor first, then use --verify.");
		db.close();
		process.exit(1);
	}

	const rangeStart = cursor.firstMonitored;
	const rangeEnd = cursor.lastFinalized;
	const totalSlotsInRange = Number(rangeEnd - rangeStart) + 1;

	console.log(`Monitored range: ${fmt(rangeStart)} → ${fmt(rangeEnd)}`);
	console.log(`Total slots in range: ${fmtNum(totalSlotsInRange)}\n`);

	// Load our recorded stats and fork events
	loadPersistedStats();
	const dbForkEvents = db.prepare("SELECT slot, type, detail FROM fork_events").all() as Array<{
		slot: number;
		type: string;
		detail: string;
	}>;
	const dbDeadSlots = new Set(
		dbForkEvents.filter((e) => e.type === "slot_drop").map((e) => e.slot),
	);
	const dbMismatches = dbForkEvents.filter((e) => e.type === "parent_mismatch");

	console.log("─── Step 1: getBlocks (confirmed vs finalized) ───");
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

	// Find specific missing slots
	const missingSlots: bigint[] = [];
	for (let s = rangeStart; s <= rangeEnd; s++) {
		if (!confirmedSlots.has(s)) missingSlots.push(s);
	}

	console.log("\n─── Step 2: getBlockProduction ───");
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

	console.log("\n─── Step 3: Reconciliation ───");

	// Compare dead+dropped against chain's missing slots.
	// "Skipped" (WS sequence gaps) is reported separately — it's unreliable because
	// slotNotification can batch/skip sequence numbers without meaning the chain skipped.
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

	// Cross-check: do our recorded drop slots actually appear as missing on chain?
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

	if (dbMismatches.length > 0) {
		console.log(`\n  Parent mismatches recorded: ${dbMismatches.length}`);
		for (const m of dbMismatches.slice(0, 10)) {
			console.log(`    Slot ${fmtNum(m.slot)}: ${m.detail}`);
		}
	}

	// Show some of the missing slots for manual inspection
	if (missingSlots.length > 0) {
		const show = missingSlots.slice(0, 20);
		console.log(
			`\n  Sample missing slots (first ${show.length} of ${fmtNum(missingSlots.length)}):`,
		);
		console.log(`    ${show.map((s) => fmt(s)).join(", ")}`);
	}

	console.log("\n─── Done ───\n");
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

	console.log(`Solana Reorg Monitor starting on ${cluster}`);
	console.log(`RPC: ${CLUSTER_URLS[cluster]}`);
	console.log(`WS:  ${CLUSTER_WS_URLS[cluster]}`);
	console.log(`DB:  ${dbPath}`);

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

	// Subscription 1: slotNotifications (stable)
	const stableWs = createSolanaRpcSubscriptions(CLUSTER_WS_URLS[cluster]);
	runWithReconnect(
		"slotNotifications",
		async (signal) => {
			const sub = await stableWs.slotNotifications().subscribe({ abortSignal: signal });
			for await (const notification of sub) {
				handleSlotNotification(notification);
			}
		},
		outerAc.signal,
	);

	// Subscription 2: slotsUpdatesNotifications (unstable)
	const unstableWs = createSolanaRpcSubscriptions_UNSTABLE(CLUSTER_WS_URLS[cluster]);
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
	);

	// Periodic tasks
	const pollTimer = setInterval(async () => {
		await pollCommitmentLevels();
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
		const summary = {
			cluster,
			runDuration: elapsed(),
			stats: { ...stats },
			pollSlots: {
				processed: Number(p),
				confirmed: Number(c),
				finalized: Number(f),
			},
			gaps: {
				processedToConfirmed: Number(p - c),
				confirmedToFinalized: Number(c - f),
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

	// Keep alive — the event loop stays open via setInterval + WebSocket subscriptions
	console.log("Subscriptions active. Press Ctrl+C to stop.\n");
}

main().catch((err) => {
	console.error("Fatal:", err);
	db.close();
	process.exit(1);
});
