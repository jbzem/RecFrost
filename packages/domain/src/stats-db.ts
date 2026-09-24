/**
 * Server statistics sampled over time (`stat` table). The `match` presence cron
 * records one `online` sample per run — the count of live `presence` rows once the
 * expired ones are swept. Migration: apps/match/migrations/0002_stat.sql.
 */

/** Schema DDL (mirror of apps/match/migrations/0002_stat.sql). */
export const STAT_SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS stat (
		stat_type TEXT NOT NULL,
		value INTEGER NOT NULL,
		datetime TEXT NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS idx_stat_type_datetime ON stat (stat_type, datetime)`,
]

export interface StatRow {
	statType: string
	value: number
	datetime: string
}

/** Record one sample of `statType`, stamped with the current UTC time (ISO-8601). */
export async function recordStat(
	db: D1Database,
	statType: string,
	value: number,
	now: Date = new Date()
): Promise<void> {
	await db
		.prepare('INSERT INTO stat (stat_type, value, datetime) VALUES (?1, ?2, ?3)')
		.bind(statType, value, now.toISOString())
		.run()
}

/** Samples of `statType`, oldest first. */
export async function getStats(db: D1Database, statType: string, limit = 1000): Promise<StatRow[]> {
	const { results } = await db
		.prepare(
			'SELECT stat_type, value, datetime FROM stat WHERE stat_type = ?1 ORDER BY datetime ASC LIMIT ?2'
		)
		.bind(statType, limit)
		.all<{ stat_type: string; value: number; datetime: string }>()
	return results.map((r) => ({ statType: r.stat_type, value: r.value, datetime: r.datetime }))
}

/** One bucket of a {@link getStatSeries} result. */
export interface StatPoint {
	/** Start of the bucket, epoch seconds. */
	t: number
	/** Highest sample in the bucket. */
	peak: number
	/** Sum and count of the bucket's samples — kept apart so a caller can average ACROSS buckets. */
	sum: number
	samples: number
}

/**
 * The `statType` series since `since`, folded into `bucketSeconds`-wide buckets, oldest
 * first. The cron samples every five minutes, so a quarter of raw rows is ~26k points —
 * far more than a chart has pixels for; bucketing in SQL keeps the response small and
 * the peak exact. A bucket nothing was sampled in is simply absent, which is how a
 * reader tells an outage from a quiet hour.
 *
 * The range filter compares `datetime` as a string (it is ISO-8601 UTC, so it sorts
 * lexically) to stay on `idx_stat_type_datetime`; only the bucketing parses it.
 */
export async function getStatSeries(
	db: D1Database,
	statType: string,
	since: Date,
	bucketSeconds: number
): Promise<StatPoint[]> {
	const { results } = await db
		.prepare(
			// D1 binds a JS number as REAL, so the bucket width is cast back: without it the
			// division is floating-point and every sample lands in a bucket of its own.
			`SELECT (CAST(strftime('%s', datetime) AS INTEGER) / CAST(?3 AS INTEGER)) * CAST(?3 AS INTEGER) AS t,
				MAX(value) AS peak, SUM(value) AS sum, COUNT(*) AS samples
			FROM stat WHERE stat_type = ?1 AND datetime >= ?2
			GROUP BY t ORDER BY t ASC`
		)
		.bind(statType, since.toISOString(), bucketSeconds)
		.all<StatPoint>()
	return results
}
