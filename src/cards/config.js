// Choices offered in the card maker. Add a goal type by adding a line here;
// nothing else needs to change.

/**
 * `assist` says whether an assist can be credited for that kind of goal. `missed` marks a
 * penalty that was not scored (asked for on 2026-11-27): it is drawn on the goal card with its
 * own title, is left out of the full-time scorers, and plays no sound on "Automatic".
 */
export const GOAL_TYPES = [
  { id: 'open-play', label: 'Open play', assist: true },
  { id: 'penalty', label: 'Penalty', assist: false },
  { id: 'penalty-miss', label: 'Penalty missed', assist: false, missed: true },
  { id: 'free-kick', label: 'Free kick', assist: true },
  { id: 'header', label: 'Header', assist: true },
  { id: 'corner', label: 'Corner', assist: true },
  { id: 'own-goal', label: 'Own goal', assist: false },
];

export const RED_TYPES = [
  { id: 'straight', label: 'Straight red' },
  { id: 'second-yellow', label: 'Second yellow' },
];

/**
 * How a club's logo moves on a goal and a red card in a compilation (asked for on 2026-11-25):
 * it leans to the right by `degrees`, then as far to the left, `times` times over, each lean
 * to both sides taking `seconds`, starting `after` seconds into the card, and then stands straight.
 */
export const LOGO_SWING = { degrees: 10, times: 3, seconds: 0.6, after: 0.4 };

/**
 * A club icon as it is stored with a match: a small PNG written out as text.
 * The page shrinks whatever picture the owner chooses to this before saving,
 * so nothing but a plain PNG of modest size ever reaches a card.
 */
export const ICON_PIXELS = 320;
const ICON_PATTERN = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;
export const isIcon = (value) => typeof value === 'string' && value.length <= 400_000 && ICON_PATTERN.test(value);

/** The size of the picture shown for a video on YouTube, which the match's thumbnail is exported in. */
export const THUMBNAIL_SIZE = { width: 1280, height: 720 };

/** The two sizes a card is exported in. */
export const CARD_SIZES = {
  landscape: { width: 1920, height: 1080 },
  portrait: { width: 1080, height: 1920 },
};

export const goalType = (id) => GOAL_TYPES.find((type) => type.id === id) ?? GOAL_TYPES[0];
export const redType = (id) => RED_TYPES.find((type) => type.id === id) ?? RED_TYPES[0];

/**
 * The kind of sound "Automatic" plays under a card: its own type, except a missed penalty,
 * which is a goal card but must not get the goal's sound. "missed" names no sound file, so it
 * is silent. The Compilations page and the compilation builder both ask here.
 */
export const soundKindOf = (card) => (card?.type === 'goal' && goalType(card.goalType).missed ? 'missed' : card?.type);

/** A minute as it is written on a card: 12' or 45+2'. */
export function minuteLabel(minute, added) {
  if (minute === null || minute === undefined || minute === '') return '';
  return `${minute}${added ? `+${added}` : ''}'`;
}
