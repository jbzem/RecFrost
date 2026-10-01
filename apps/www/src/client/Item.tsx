import { useEffect, useState } from 'react'

import { call, usernamesFor, where } from './api'

import type { CustomAvatarItem } from '../../../api/src/custom-avatar-items-db'
import type { PublicAccount } from './api'

/**
 * A custom avatar item's page, at `/d/store/customavataritem/<id>`.
 *
 * That path is what the game puts in the clipboard for "Share" on a store item — "Check
 * out this item in RecRoom: https://<www>/d/store/customavataritem/<uuid>" — so it has to
 * be exactly this, and it's the one URL on this site whose shape isn't ours to choose.
 * The uuid is a `CustomAvatarItemId` on `api`'s `custom_avatar_item` table.
 *
 * Read through `api`'s bulk lookup (`POST /api/customAvatarItems/v1/bulk`), the same call
 * the game makes to draw a shelf of items, with a batch of one — there is no single-item
 * GET, and www reading the table itself would tie the site to a schema another worker
 * owns (the room and player pages go to `rooms` and `accounts` for the same reason). That
 * route wants a token, so a signed-out visitor is asked to sign in and brought back here
 * afterwards (the `?next=` on the login link). Unpublished items miss for everyone but
 * their creator, so a draft's link says "no item here" to anyone else, which is what the
 * store says too.
 *
 * Its own file for the reason Stats.tsx and Moderation.tsx are: a whole surface rather
 * than one more section of App.tsx.
 */

/** The `/d/store/customavataritem/<uuid>` path, or null for any other path. */
export function customAvatarItemIdFromPath(path: string): string | null {
	// Case-insensitive on the fixed segments: the game writes them lower-case, but a link
	// retyped by hand shouldn't 404 on `CustomAvatarItem`. The id is normalised to lower
	// case to match how the table stores it.
	const match =
		/^\/d\/store\/customavataritem\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/?$/i.exec(path)
	return match ? match[1]!.toLowerCase() : null
}

/**
 * The item, or null when the lookup came back without it: unknown, or unpublished and not
 * the caller's. The bulk route answers a bare array of the ids that matched, in request
 * order, and a miss is silence rather than an error.
 */
async function fetchCustomAvatarItem(itemId: string): Promise<CustomAvatarItem | null> {
	const items = await call<CustomAvatarItem[]>(`${where().api}/api/customAvatarItems/v1/bulk`, {
		form: { customAvatarItemIds: itemId },
		authed: true,
	})
	if (!Array.isArray(items)) return null
	return items.find((i) => i.CustomAvatarItemId?.toLowerCase() === itemId) ?? null
}

/**
 * The image that stands for the item. A player-made shirt has a thumbnail of its own under
 * `ThumbnailImageFilename`; a first-party item has none and is drawn from its saves, each of
 * which carries the store thumbnail for one body type — the first is as good as any here.
 * Both are keys on the `img` worker. Null when there's nothing to show, which shouldn't
 * happen for a served item but must not break the page when it does.
 */
function thumbnailKey(item: CustomAvatarItem): string | null {
	if (item.ThumbnailImageFilename) return item.ThumbnailImageFilename
	const save = item.CurrentSaves?.find((s) => s.ThumbnailFileName)
	return save?.ThumbnailFileName ?? null
}

/**
 * The `OutfitType` slot's name — `RecRoom.Avatars.OutfitType`, banded by body region (see
 * the enum note in api's custom-avatar-items-db.ts). Only the members seen on this table
 * are named; anything else is shown by number rather than guessed at.
 */
const OUTFIT_TYPE_LABEL: Record<number, string> = {
	0: 'Hat',
	2: 'Hair',
	3: 'Ears',
	10: 'Eyes',
	20: 'Beard',
	100: 'Shoulders',
	101: 'Shirt',
	102: 'Waist',
	103: 'Neck',
	104: 'Team jersey',
	105: 'Custom shirt',
	200: 'Wrist',
	203: 'Team wrist',
	300: 'Legs',
	301: 'Feet',
	500: 'Roomie hat',
	501: 'Roomie waist',
	502: 'Roomie eyes',
}

function outfitTypeLabel(type: number): string {
	return OUTFIT_TYPE_LABEL[type] ?? `Slot ${type}`
}

function formatDate(iso: string): string {
	const date = new Date(iso)
	return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString()
}

export function ItemPage({
	itemId,
	signedIn,
	navigate,
}: {
	itemId: string
	/**
	 * undefined while the stored token is still being checked, null when signed out — the
	 * lookup can't be made without a session, so the page waits on this rather than on
	 * the config alone.
	 */
	signedIn: boolean | undefined
	navigate: (to: string) => void
}) {
	// undefined = not fetched yet; null = nothing served for this id.
	const [item, setItem] = useState<CustomAvatarItem | null | undefined>(undefined)
	const [creator, setCreator] = useState<PublicAccount | null>(null)
	const [error, setError] = useState('')

	useEffect(() => {
		setItem(undefined)
		setCreator(null)
		setError('')
		if (!signedIn) return
		void fetchCustomAvatarItem(itemId)
			.then((found) => {
				setItem(found)
				if (found)
					void usernamesFor([found.CreatorAccountId]).then((names) =>
						setCreator(names.get(found.CreatorAccountId) ?? null)
					)
			})
			.catch((e) => setError(e instanceof Error ? e.message : String(e)))
	}, [itemId, signedIn])

	const here = `/d/store/customavataritem/${itemId}`

	if (signedIn === null || signedIn === false) {
		return (
			<main className="shell wide">
				<section className="card">
					<h1>Sign in to see this item</h1>
					<p className="muted">
						Items in the store are shown to signed-in players. Sign in and you&apos;ll be brought
						straight back here.
					</p>
					<p>
						<a
							className="cta"
							href={`/login?next=${encodeURIComponent(here)}`}
							onClick={(e) => {
								e.preventDefault()
								navigate(`/login?next=${encodeURIComponent(here)}`)
							}}
						>
							Sign in
						</a>
					</p>
				</section>
			</main>
		)
	}

	if (error) {
		return (
			<main className="shell wide">
				<p className="error">{error}</p>
			</main>
		)
	}
	if (item === undefined) {
		return (
			<main className="shell wide">
				<p className="muted">Loading…</p>
			</main>
		)
	}
	if (item === null) {
		return (
			<main className="shell wide">
				<p className="muted">
					There&apos;s no item here — it hasn&apos;t been published, or it doesn&apos;t exist.
				</p>
			</main>
		)
	}

	const thumb = thumbnailKey(item)
	// A first-party item is built as Unity assetbundles rather than painted on a base
	// shirt; that, not the creator id, is what tells the two kinds apart on the record.
	const firstParty = item.CurrentSaves?.length > 0 && !item.DesignFilename
	const published = item.Accessibility !== 0

	return (
		<main className="shell wide">
			<section className="card room-hero">
				{thumb ? (
					<img
						className="room-hero-img item-hero-img"
						src={`${where().img}/${thumb}?width=512`}
						alt=""
					/>
				) : (
					<div className="room-hero-img item-hero-img" />
				)}
				<div className="room-hero-body">
					<div className="room-head">
						<h1 className="room-hero-name">{item.Name}</h1>
						<span className={`badge ${published ? 'live' : ''}`}>
							{published ? 'Published' : 'Unpublished'}
						</span>
					</div>
					{creator && (
						<p className="room-hero-by">
							by{' '}
							<a
								href={`/u/${encodeURIComponent(creator.username)}`}
								onClick={(e) => {
									e.preventDefault()
									navigate(`/u/${encodeURIComponent(creator.username)}`)
								}}
							>
								{creator.displayName || creator.username}
							</a>
						</p>
					)}
					{item.Description ? (
						<p className="muted room-hero-desc">{item.Description}</p>
					) : (
						<p className="muted room-hero-desc">No description.</p>
					)}
					<p className="room-stats">
						{item.Price > 0 ? `${item.Price.toLocaleString()} tokens` : 'Free'}
						{item.IsFeatured ? ' · Featured' : ''}
						{item.IsRecRoomApproved ? ' · Approved' : ''}
					</p>
				</div>
			</section>

			<section className="card">
				<h2>About this item</h2>
				<dl className="facts">
					<dt>Price</dt>
					<dd>{item.Price > 0 ? `${item.Price.toLocaleString()} tokens` : 'Free'}</dd>
					<dt>Type</dt>
					<dd>
						{outfitTypeLabel(item.OutfitType)}
						{firstParty ? ' · official item' : ''}
					</dd>
					{item.BaseAvatarItemColor && (
						<>
							<dt>Base colour</dt>
							<dd>
								<span className="swatch" style={{ background: item.BaseAvatarItemColor }} />{' '}
								{item.BaseAvatarItemColor}
							</dd>
						</>
					)}
					<dt>Tags</dt>
					<dd>{item.Tags?.length ? item.Tags.map((t) => `#${t.Value}`).join(' ') : 'None'}</dd>
					<dt>Created</dt>
					<dd>{formatDate(item.CreatedAt)}</dd>
					<dt>Updated</dt>
					<dd>{formatDate(item.ModifiedAt)}</dd>
					<dt>Item id</dt>
					<dd>
						<code>{item.CustomAvatarItemId}</code>
					</dd>
				</dl>
			</section>
		</main>
	)
}
