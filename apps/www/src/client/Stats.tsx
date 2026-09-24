import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { call } from './api'

import type { KeyboardEvent, PointerEvent } from 'react'

/**
 * The public stats page, at `/stats`: how many players are online, and how that has
 * moved. One series — the `online` samples the `match` presence cron writes to `stat` —
 * read from `www`'s own `/api/stats/online` (see www.app.ts), which folds them into
 * buckets so the quarter view doesn't ship 26,000 points.
 *
 * Its own file for the reason Moderation.tsx is: a whole surface rather than one more
 * form. The chart is hand-drawn SVG — one line doesn't justify a charting dependency in a
 * bundle whose homepage is a poster.
 */

type Range = '24h' | '7d' | '30d' | '90d'

// Shortest first: "what's it like right now" is the question most visitors arrive with.
const RANGES: Array<{ id: Range; label: string; title: string }> = [
	{ id: '24h', label: '24 hours', title: 'the last 24 hours' },
	{ id: '7d', label: '7 days', title: 'the last 7 days' },
	{ id: '30d', label: '30 days', title: 'the last 30 days' },
	{ id: '90d', label: '90 days', title: 'the last 90 days' },
]

interface Point {
	/** Start of the bucket, epoch seconds. */
	t: number
	/** The bucket's peak. */
	players: number
}

interface OnlineStats {
	range: Range
	bucketSeconds: number
	from: number
	to: number
	online: number
	peak: number
	average: number
	points: Point[]
}

/** How often the page re-asks. The cron samples every five minutes; the live count moves faster. */
const REFRESH_MS = 60_000

const DAY = 86_400

function rangeFromSearch(search: string): Range {
	const asked = new URLSearchParams(search).get('range')
	return RANGES.find((r) => r.id === asked)?.id ?? '24h'
}

export function StatsPage({
	search,
	navigate,
}: {
	search: string
	navigate: (to: string) => void
}) {
	// The range lives in the URL so a view is linkable ("look at last month") and the back
	// button walks back through the ranges, the way the moderation panel's filters do.
	const range = rangeFromSearch(search)
	const [stats, setStats] = useState<OnlineStats | null>(null)
	const [error, setError] = useState('')

	useEffect(() => {
		let cancelled = false
		const load = () =>
			call<OnlineStats>(`/api/stats/online?range=${range}`)
				.then((next) => {
					if (cancelled) return
					setStats(next)
					setError('')
				})
				.catch((e: Error) => {
					if (!cancelled) setError(e.message)
				})
		void load()
		// Only while someone is looking: a backgrounded tab polling a public endpoint all
		// night is traffic nobody reads.
		const timer = setInterval(() => {
			if (document.visibilityState === 'visible') void load()
		}, REFRESH_MS)
		return () => {
			cancelled = true
			clearInterval(timer)
		}
	}, [range])

	// The previous range's numbers stay on screen (dimmed) until the new ones land, so
	// flipping ranges doesn't collapse the page to a spinner and back.
	const stale = stats !== null && stats.range !== range
	// Named from the data on screen, not the range just clicked: while the new one loads,
	// the old chart must not be captioned as the new window.
	const shown = RANGES.find((r) => r.id === stats?.range)?.title ?? ''

	return (
		<main className="shell home stats">
			<header className="stats-head">
				<h1>Players online</h1>
				<p className="muted">How many people are in the game, now and lately.</p>
			</header>

			<div className="stats-ranges" role="group" aria-label="Time range">
				{RANGES.map((r) => (
					<button
						key={r.id}
						className={r.id === range ? 'active' : ''}
						aria-pressed={r.id === range}
						onClick={() => navigate(r.id === '24h' ? '/stats' : `/stats?range=${r.id}`)}
					>
						{r.label}
					</button>
				))}
			</div>

			{error && stats === null ? (
				<p className="error">Couldn’t load the stats: {error}</p>
			) : stats === null ? (
				<p className="muted">Loading…</p>
			) : (
				<div className={stale ? 'stats-body stale' : 'stats-body'}>
					<dl className="stat-tiles">
						<div className="stat-tile">
							<dt>
								<span className="stat-live-dot" aria-hidden="true" />
								Online now
							</dt>
							<dd className="hero">{formatCount(stats.online)}</dd>
						</div>
						<div className="stat-tile">
							<dt>Peak</dt>
							<dd>{formatCount(stats.peak)}</dd>
						</div>
						<div className="stat-tile">
							<dt>Average</dt>
							<dd>{formatAverage(stats.average)}</dd>
						</div>
					</dl>

					<section className="card stats-card">
						<h2>{chartTitle(stats.bucketSeconds)}</h2>
						<p className="muted">Over {shown}, in your local time.</p>
						{stats.points.length === 0 ? (
							<p className="stats-empty muted">Nothing has been recorded in this window yet.</p>
						) : (
							<>
								<OnlineChart stats={stats} />
								<details className="stats-table">
									<summary>View as a table</summary>
									<div className="stats-table-scroll">
										<table>
											<thead>
												<tr>
													<th scope="col">When</th>
													<th scope="col">Players</th>
												</tr>
											</thead>
											<tbody>
												{/* Newest first: the row someone opens a table for is the latest. */}
												{[...stats.points].reverse().map((p) => (
													<tr key={p.t}>
														<td>{bucketLabel(p.t, stats.bucketSeconds)}</td>
														<td>{formatCount(p.players)}</td>
													</tr>
												))}
											</tbody>
										</table>
									</div>
								</details>
							</>
						)}
					</section>
					{error && <p className="error">Couldn’t refresh: {error}</p>}
				</div>
			)}
		</main>
	)
}

// ---- Formatting ------------------------------------------------------------

const countFormat = new Intl.NumberFormat()
const formatCount = (n: number) => countFormat.format(n)

/** One decimal while the numbers are small enough for it to mean something. */
const formatAverage = (n: number) =>
	new Intl.NumberFormat(undefined, { maximumFractionDigits: n < 100 ? 1 : 0 }).format(n)

/** Says what a point IS: a raw sample on the day view, a bucket's peak on the rest. */
function chartTitle(bucketSeconds: number): string {
	if (bucketSeconds <= 300) return 'Players online, every 5 minutes'
	if (bucketSeconds >= DAY) return 'Peak players online, per day'
	const hours = bucketSeconds / 3600
	return hours === 1 ? 'Peak players online, per hour' : `Peak players online, per ${hours} hours`
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const dayTimeFormat = new Intl.DateTimeFormat(undefined, {
	weekday: 'short',
	month: 'short',
	day: 'numeric',
	hour: 'numeric',
	minute: '2-digit',
})
// A day bucket is a UTC day (the server folds on epoch seconds), so it is NAMED in UTC —
// formatting its start in local time would call it "Sep 13, 8 PM" for half the world.
const utcDayFormat = new Intl.DateTimeFormat(undefined, {
	weekday: 'short',
	month: 'short',
	day: 'numeric',
	timeZone: 'UTC',
})

function bucketLabel(t: number, bucketSeconds: number): string {
	if (bucketSeconds >= DAY) return `${utcDayFormat.format(t * 1000)} (UTC)`
	const start = dayTimeFormat.format(t * 1000)
	if (bucketSeconds <= 300) return start
	return `${start} – ${timeFormat.format((t + bucketSeconds) * 1000)}`
}

// ---- Axes ------------------------------------------------------------------

/**
 * Y ticks on whole, round numbers. Whole matters more than round here: this is a count of
 * people, and a young server's axis topping out at "2.5" reads as a bug.
 */
function yTicks(max: number): number[] {
	const rough = Math.max(max, 1) / 4
	const magnitude = 10 ** Math.floor(Math.log10(rough))
	const step = Math.max(1, [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ?? 1)
	const top = Math.max(step, Math.ceil(max / step) * step)
	const ticks: number[] = []
	for (let v = 0; v <= top; v += step) ticks.push(v)
	return ticks
}

const HOUR_STEPS = [1, 2, 3, 4, 6, 12]
const DAY_STEPS = [1, 2, 3, 7, 14, 28]
const hourTick = new Intl.DateTimeFormat(undefined, { hour: 'numeric' })
const dayTick = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })

/**
 * X ticks on LOCAL clock boundaries (midnights, or hours divisible by the step), as many
 * as fit: the step is the smallest whose labels get `minGap` pixels each, so the same
 * code serves a phone and a desktop without labels colliding.
 */
function xTicks(from: number, to: number, width: number, minGap: number) {
	const fits = (stepSeconds: number) => ((to - from) / stepSeconds) * minGap <= width
	const hours = HOUR_STEPS.find((h) => fits(h * 3600))
	const ticks: Array<{ t: number; label: string }> = []
	if (to - from <= 2 * DAY && hours !== undefined) {
		const cursor = new Date(from * 1000)
		cursor.setMinutes(0, 0, 0)
		for (; cursor.getTime() / 1000 <= to; cursor.setHours(cursor.getHours() + 1)) {
			const t = cursor.getTime() / 1000
			if (t >= from && cursor.getHours() % hours === 0) {
				ticks.push({ t, label: hourTick.format(cursor) })
			}
		}
		return ticks
	}
	const days = DAY_STEPS.find((d) => fits(d * DAY)) ?? DAY_STEPS[DAY_STEPS.length - 1]!
	const midnights: Date[] = []
	const cursor = new Date(from * 1000)
	cursor.setHours(0, 0, 0, 0)
	// setDate rather than adding 86,400s: a DST day isn't 24 hours long.
	for (; cursor.getTime() / 1000 <= to; cursor.setDate(cursor.getDate() + 1)) {
		if (cursor.getTime() / 1000 >= from) midnights.push(new Date(cursor))
	}
	// Counted back from the newest so the most recent midnight is always labelled.
	midnights.forEach((d, i) => {
		if ((midnights.length - 1 - i) % days === 0) {
			ticks.push({ t: d.getTime() / 1000, label: dayTick.format(d) })
		}
	})
	return ticks
}

// ---- Chart -----------------------------------------------------------------

const HEIGHT = 300
const MARGIN = { top: 16, right: 16, bottom: 28, left: 40 }

/**
 * The line. X spans the WINDOW (`from`–`to`), not the data, so a server with three days
 * of history shows three days at the right of the 90-day view instead of stretching them
 * across it. The line BREAKS where buckets are missing — the cron didn't run, which is
 * an outage, and a straight line drawn across it would invent players for the gap.
 */
function OnlineChart({ stats }: { stats: OnlineStats }) {
	const { points, from, to, bucketSeconds } = stats
	const frame = useRef<HTMLDivElement>(null)
	// Measured rather than scaled through a viewBox: scaling would shrink the axis type on
	// a phone along with the plot.
	const [width, setWidth] = useState(0)
	const [hover, setHover] = useState<number | null>(null)

	useLayoutEffect(() => {
		const el = frame.current
		if (!el) return
		setWidth(el.clientWidth)
		const observer = new ResizeObserver(() => setWidth(el.clientWidth))
		observer.observe(el)
		return () => observer.disconnect()
	}, [])

	// A hovered index means nothing against a different series.
	useEffect(() => setHover(null), [stats])

	const plot = useMemo(() => {
		const innerW = Math.max(width - MARGIN.left - MARGIN.right, 1)
		const innerH = HEIGHT - MARGIN.top - MARGIN.bottom
		const ticks = yTicks(points.reduce((max, p) => Math.max(max, p.players), 0))
		const top = ticks[ticks.length - 1] ?? 1
		const x = (t: number) => MARGIN.left + ((t - from) / (to - from)) * innerW
		const y = (v: number) => MARGIN.top + innerH - (v / top) * innerH

		// Runs of consecutive buckets. 2.5× tolerates one late sample without breaking the
		// line, and still breaks it for a real hole.
		const runs: Point[][] = []
		for (const p of points) {
			const run = runs[runs.length - 1]
			const last = run?.[run.length - 1]
			if (run && last && p.t - last.t <= bucketSeconds * 2.5) run.push(p)
			else runs.push([p])
		}
		const baseline = y(0)
		const paths = runs.map((run) => {
			const line = run.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t)},${y(p.players)}`).join('')
			const first = run[0]!
			const last = run[run.length - 1]!
			return {
				line,
				area: `${line}L${x(last.t)},${baseline}L${x(first.t)},${baseline}Z`,
				// A one-bucket run has no length to stroke; it gets a dot instead.
				lone: run.length === 1 ? first : null,
			}
		})
		return { x, y, ticks, paths, baseline, innerW }
	}, [points, from, to, bucketSeconds, width])

	const nearest = (clientX: number): number | null => {
		const el = frame.current
		if (!el || points.length === 0) return null
		const px = clientX - el.getBoundingClientRect().left
		let best = 0
		for (let i = 1; i < points.length; i++) {
			if (Math.abs(plot.x(points[i]!.t) - px) < Math.abs(plot.x(points[best]!.t) - px)) best = i
		}
		return best
	}

	const onPointerMove = (e: PointerEvent) => setHover(nearest(e.clientX))

	// The same readout from the keyboard: arrows walk the points, Home/End jump, Escape
	// puts it away.
	const onKeyDown = (e: KeyboardEvent) => {
		const last = points.length - 1
		const moves: Record<string, number | null> = {
			ArrowLeft: Math.max((hover ?? points.length) - 1, 0),
			ArrowRight: Math.min((hover ?? -1) + 1, last),
			Home: 0,
			End: last,
			Escape: null,
		}
		if (!(e.key in moves)) return
		e.preventDefault()
		setHover(moves[e.key] ?? null)
	}

	const hovered = hover === null ? undefined : points[hover]
	const latest = points[points.length - 1]!
	const tipX = hovered ? plot.x(hovered.t) : 0
	// Past the midpoint the readout sits to the LEFT of the crosshair, so it never runs off
	// the card.
	const tipLeft = tipX > width / 2

	return (
		<div
			ref={frame}
			className="stats-chart"
			tabIndex={0}
			role="group"
			aria-label={`Line chart of players online. Latest: ${formatCount(latest.players)}. Use the arrow keys to read each point; the same numbers are in the table below.`}
			onKeyDown={onKeyDown}
			onBlur={() => setHover(null)}
		>
			{width > 0 && (
				<svg
					width={width}
					height={HEIGHT}
					aria-hidden="true"
					onPointerMove={onPointerMove}
					onPointerDown={onPointerMove}
					onPointerLeave={() => setHover(null)}
				>
					{plot.ticks.map((v) => (
						<g key={v}>
							<line
								className="grid"
								x1={MARGIN.left}
								x2={width - MARGIN.right}
								y1={plot.y(v)}
								y2={plot.y(v)}
							/>
							<text className="tick" x={MARGIN.left - 8} y={plot.y(v)} dy="0.32em" textAnchor="end">
								{formatCount(v)}
							</text>
						</g>
					))}
					{xTicks(from, to, plot.innerW, 72).map((tick) => (
						<text
							key={tick.t}
							className="tick"
							x={plot.x(tick.t)}
							y={HEIGHT - 8}
							// A label centred on a tick at the very edge would hang outside the plot.
							textAnchor={plot.x(tick.t) > width - MARGIN.right - 24 ? 'end' : 'middle'}
						>
							{tick.label}
						</text>
					))}

					{plot.paths.map((p, i) => (
						<g key={i}>
							<path className="area" d={p.area} />
							<path className="series" d={p.line} />
							{p.lone && (
								<circle
									className="series-dot"
									cx={plot.x(p.lone.t)}
									cy={plot.y(p.lone.players)}
									r="2.5"
								/>
							)}
						</g>
					))}

					{hovered && (
						<line className="crosshair" x1={tipX} x2={tipX} y1={MARGIN.top} y2={plot.baseline} />
					)}
					{/* The end-dot marks "latest"; while reading another point it moves there. */}
					<circle
						className="marker"
						cx={plot.x((hovered ?? latest).t)}
						cy={plot.y((hovered ?? latest).players)}
						r="5"
					/>
				</svg>
			)}
			{hovered && (
				<div
					className="stats-tip"
					role="status"
					style={tipLeft ? { right: width - tipX + 12 } : { left: tipX + 12 }}
				>
					<strong>
						{formatCount(hovered.players)} {hovered.players === 1 ? 'player' : 'players'}
					</strong>
					<span>{bucketLabel(hovered.t, bucketSeconds)}</span>
				</div>
			)}
		</div>
	)
}
