// Putting together a list that was changed on two machines since they last
// agreed.
//
// A list is a set of records with ids (channels, leagues, clubs). Each
// record is looked at by itself, against what it was when the machines last
// agreed:
//
//   changed on one machine only     that change is taken
//   added or removed on one only    it is added or removed
//   changed on both, differently    GitHub's is taken, and the record is
//                                   named as a clash so the owner is told
//
// Nothing is merged inside a record, and nothing is decided without being
// reported.

/**
 * @template T
 * @param {T[] | null} base     the list when the machines last agreed, or null when there was none
 * @param {T[]} here            the list on this machine
 * @param {T[]} there           the list on GitHub
 * @param {(record: T) => string} idOf
 * @returns {{ merged: T[], clashes: string[] }} `clashes` holds the ids that were changed on both
 */
export function mergeRecords(base, here, there, idOf) {
  const byId = (list) => new Map((list ?? []).map((record) => [idOf(record), JSON.stringify(record)]));
  const [was, mine, theirs] = [byId(base), byId(here), byId(there)];
  const merged = [];
  const clashes = [];
  // GitHub's order first, then what only this machine has.
  for (const id of new Set([...theirs.keys(), ...mine.keys()])) {
    const [b, l, r] = [was.get(id), mine.get(id), theirs.get(id)];
    let kept;
    if (l === r) kept = l;
    else if (l === b) kept = r; // only GitHub changed it, or removed it
    else if (r === b) kept = l; // only this machine changed it, or removed it
    else {
      clashes.push(id);
      kept = r ?? l; // GitHub's; a record removed there but changed here is kept
    }
    if (kept !== undefined) merged.push(JSON.parse(kept));
  }
  return { merged, clashes };
}

/** The channels list. */
export function mergeSources(base, here, there) {
  const { merged, clashes } = mergeRecords(base, here, there, (source) => source.id);
  return { merged, clashes: clashes.map((id) => `channel ${id}`) };
}

/** The leagues and clubs, as kept on GitHub (logos named, not written in). */
export function mergeLibrary(base, here, there) {
  const leagues = mergeRecords(base?.leagues ?? null, here.leagues ?? [], there.leagues ?? [], (league) => league.id);
  const clubs = mergeRecords(base?.clubs ?? null, here.clubs ?? [], there.clubs ?? [], (club) => club.id);
  // A club whose league went on the other machine goes with it.
  const known = new Set(leagues.merged.map((league) => league.id));
  return {
    merged: { leagues: leagues.merged, clubs: clubs.merged.filter((club) => known.has(club.league)).sort((a, b) => a.name.localeCompare(b.name)) },
    clashes: [...leagues.clashes.map((id) => `league ${id}`), ...clubs.clashes.map((id) => `club ${id}`)],
  };
}

/** Subscriber counts: for each channel, the count that was read last. */
export function mergeSubscribers(here, there) {
  const merged = { ...there };
  for (const [id, one] of Object.entries(here ?? {})) {
    if (!merged[id] || String(one?.checked) > String(merged[id]?.checked)) merged[id] = one;
  }
  return merged;
}
