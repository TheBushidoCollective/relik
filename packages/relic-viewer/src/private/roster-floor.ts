/**
 * The owner-signed roster floor this browser holds for one owner identity
 * (PS2-02, PS2-03). It records the newest recovery designation, and a mark per
 * device and per grant, and only ever moves forward, so a service that replays
 * an older roster after a newer one was accepted is refused before any key is
 * wrapped. It holds ids and timestamps only, never key material, and it stays in
 * this browser's localStorage. It is never sent to the service or put in a URL.
 *
 * The browser has no record of a revocation it never received. A first visit, or
 * a cleared store, starts with an empty floor, which the service cannot be held
 * to. Once a verified designation or revocation is accepted, the floor keeps it.
 */

import {
  advanceRosterFloor,
  type RosterFloor,
  type RosterObservation,
  RosterStaleError,
} from '@relic/format/private';
import { VerificationRefusedError } from './refusal.ts';

const PREFIX = 'relic.private.roster-floor.v1:';

/** Used when localStorage is unavailable: the floor then lasts for this page only. */
const pageFloors = new Map<string, RosterFloor>();

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

function unreadable(): VerificationRefusedError {
  return new VerificationRefusedError(
    'this browser\u2019s record of your recovery and access is unreadable. Nothing was sent.'
  );
}

/** A stored device or grant mark: a time and a revoked flag. */
function isMark(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'at' in value &&
    typeof value.at === 'number' &&
    'revoked' in value &&
    typeof value.revoked === 'boolean'
  );
}

/** A stored designation: a time and a removed flag. */
function isDesignation(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'at' in value &&
    typeof value.at === 'number' &&
    'removed' in value &&
    typeof value.removed === 'boolean'
  );
}

/** A stored map of marks, by key. */
function isMarkMap(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value).every(isMark)
  );
}

function parseFloor(raw: string): RosterFloor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw unreadable();
  }
  if (typeof parsed !== 'object' || parsed === null) throw unreadable();
  const designation = 'designation' in parsed ? parsed.designation : undefined;
  const devices = 'devices' in parsed ? parsed.devices : undefined;
  const grants = 'grants' in parsed ? parsed.grants : undefined;
  if (
    (designation !== undefined && !isDesignation(designation)) ||
    (devices !== undefined && !isMarkMap(devices)) ||
    (grants !== undefined && !isMarkMap(grants))
  ) {
    throw unreadable();
  }
  // Every field was checked above, so this value is the floor the store wrote.
  return parsed as RosterFloor;
}

/** The floor this browser holds for one owner identity. Empty when nothing is recorded. */
export function loadRosterFloor(identityId: string): RosterFloor {
  const store = storage();
  if (store === undefined) return pageFloors.get(identityId) ?? {};
  let raw: string | null;
  try {
    raw = store.getItem(PREFIX + identityId);
  } catch {
    return pageFloors.get(identityId) ?? {};
  }
  return raw === null ? {} : parseFloor(raw);
}

function saveRosterFloor(identityId: string, floor: RosterFloor): void {
  pageFloors.set(identityId, floor);
  const store = storage();
  if (store === undefined) return;
  try {
    store.setItem(PREFIX + identityId, JSON.stringify(floor));
  } catch {
    // The floor still holds for this page. Storage that refuses writes cannot
    // carry it to the next visit, so the next visit starts from an empty floor.
  }
}

/**
 * Hold a verified answer to the floor, record it, and return the floor the
 * answer is admitted against. A refused answer records nothing.
 */
export function observeRosterFloor(
  identityId: string,
  observed: RosterObservation
): RosterFloor {
  let floor: RosterFloor;
  try {
    floor = advanceRosterFloor(loadRosterFloor(identityId), observed);
  } catch (error) {
    if (error instanceof RosterStaleError) {
      throw new VerificationRefusedError(
        `the service answered with an older view of your recovery and access than this browser has accepted (${error.what}). Nothing was sent.`
      );
    }
    throw error;
  }
  saveRosterFloor(identityId, floor);
  return floor;
}
