/**
 * Sending a player back to their own dorm — the move every kick makes.
 *
 * A kick used to DELETE the kicked player's presence row. The client goes to the dorm on its
 * own either way, but with no presence to read it arrives without knowing where it is and
 * loads the dorm a second time, so the player watches it appear twice. Writing the dorm into
 * presence instead leaves them where they are actually standing, and the extra load goes away.
 *
 * The presence written names the OFFLINE DORM: the player's own dorm room, with the sentinel
 * instance id {@link OFFLINE_DORM_INSTANCE_ID} (-2) in place of a `room_instance` row. That is
 * the same shape `auth` seeds a brand-new player's Orientation presence with — a room the
 * client loads locally, with no session behind it and nobody else in it. A kicked player is
 * not joining a session, so minting a real instance for them said otherwise: it put a live
 * dorm session on the books, one per kick, that nothing would ever join.
 *
 * Lives in `@repo/domain` rather than in `match` because the callers are the workers that
 * kick: `api`'s moderation kicks and vote-kicks, `rooms`' ban, and `www`'s server ban.
 */

import { RoomInstanceType } from './enums'
import { GAME_VERSION, getPresence, setPresence } from './presence-db'
import { refreshInstanceFullness } from './room-instance-db'
import { getOrCreateDormRoom, subRoomDataBlob } from './rooms-db'

import type { SubRoom } from './rooms-db'

/**
 * The sentinel `roomInstanceId` for a room the client is in WITHOUT a live session — what
 * `auth` seeds Orientation with, and what a kicked player's dorm carries.
 *
 * It must be this exact value on the wire: the heartbeat echoes the id back, and a client
 * whose presence names an instance it isn't in treats presence as out of sync and bounces the
 * player to the dorm — the second load this whole helper exists to avoid. `match` also reads
 * it directly, leaving a logout that still points at -2 alone.
 */
export const OFFLINE_DORM_INSTANCE_ID = -2

/** The instance shape a presence row carries — what `match` writes and `/matchmake/none` serves. */
export interface PresenceRoomInstance {
	roomInstanceId: number
	roomId: number
	subRoomId: number
	roomInstanceType: number
	location: string
	dataBlob: string
	eventId: number
	clubId: number
	roomCode: string
	photonRegion: string
	photonRegionId: string
	photonRoomId: string
	name: string
	maxCapacity: number
	isFull: boolean
	isPrivate: boolean
	isInProgress: boolean
	EncryptVoiceChat: boolean
}

/** What a kicked player's presence says about the room they came from. */
interface LeftInstance {
	roomInstanceId?: number
	photonRegionId?: string
}

/**
 * Move a player's presence into their own offline dorm, creating the dorm room if they have
 * none, and return the instance written.
 *
 * Everything else about their presence is carried forward — device class, platform, build,
 * status visibility and the session's login lock — because none of it changed by being kicked;
 * only where they are standing did. A player with NO live presence is left alone and `null` is
 * returned: they are offline, and there is nothing to move.
 *
 * The instance they left has its fullness recomputed, as every other departure does, so the
 * room they were kicked out of frees a slot.
 */
export async function movePlayerToDorm(
	db: D1Database,
	accountId: number
): Promise<PresenceRoomInstance | null> {
	const prev = await getPresence<LeftInstance>(db, accountId)
	if (!prev) return null

	const room = await getOrCreateDormRoom(db, accountId)
	const roomId = typeof room.RoomId === 'number' ? room.RoomId : 0
	const sub = (Array.isArray(room.SubRooms) ? room.SubRooms : [])[0] as SubRoom | undefined
	// Inherited rather than configured: these workers have no Photon bindings, and there is no
	// session to connect to anyway — the dorm is loaded locally.
	const photonRegionId = prev.roomInstance?.photonRegionId || 'us'

	const roomInstance: PresenceRoomInstance = {
		roomInstanceId: OFFLINE_DORM_INSTANCE_ID,
		roomId,
		subRoomId: typeof sub?.SubRoomId === 'number' ? sub.SubRoomId : 1,
		roomInstanceType: RoomInstanceType.Dormroom,
		location: typeof sub?.UnitySceneId === 'string' ? sub.UnitySceneId : '',
		dataBlob: subRoomDataBlob(sub),
		eventId: 0,
		clubId: 0,
		roomCode: '',
		photonRegion: photonRegionId,
		photonRegionId,
		// Derived from the room like Orientation's, rather than a fresh GUID: there is no Photon
		// session here, and a new id per kick would suggest one.
		photonRoomId: `rec.${roomId}`,
		// A dorm's name carries the owner prefix (`@<user>'s Dorm`) and must NOT also get the
		// `^` an ordinary instance name takes — see `instanceFieldsFromRoom` in `match`.
		name: typeof room.Name === 'string' ? room.Name : '',
		maxCapacity: typeof sub?.MaxPlayers === 'number' ? sub.MaxPlayers : 4,
		isFull: false,
		isPrivate: true,
		isInProgress: false,
		EncryptVoiceChat: false,
	}

	await setPresence(db, {
		accountId,
		roomInstance,
		statusVisibility: prev.statusVisibility ?? 0,
		deviceClass: prev.deviceClass ?? 0,
		vrMovementMode: prev.vrMovementMode ?? 1,
		platform: prev.platform ?? 0,
		appVersion: prev.appVersion ?? GAME_VERSION,
		// Carried forward so the heartbeat can keep verifying the session it belongs to.
		loginLock: prev.loginLock,
	})

	// The room they left lost a player. Nothing to recompute on the other side: the offline
	// dorm has no `room_instance` row, which is the point of the sentinel.
	const leftId = prev.roomInstance?.roomInstanceId
	if (leftId !== undefined && leftId !== OFFLINE_DORM_INSTANCE_ID) {
		await refreshInstanceFullness(db, leftId)
	}

	return roomInstance
}
