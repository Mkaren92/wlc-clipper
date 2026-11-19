// Choices offered in the card maker. Add a goal type by adding a line here;
// nothing else needs to change.

/** `assist` says whether an assist can be credited for that kind of goal. */
export const GOAL_TYPES = [
  { id: 'open-play', label: 'Open play', assist: true },
  { id: 'penalty', label: 'Penalty', assist: false },
  { id: 'free-kick', label: 'Free kick', assist: true },
  { id: 'header', label: 'Header', assist: true },
  { id: 'corner', label: 'Corner', assist: true },
  { id: 'own-goal', label: 'Own goal', assist: false },
];

export const RED_TYPES = [
  { id: 'straight', label: 'Straight red' },
  { id: 'second-yellow', label: 'Second yellow' },
];

/** The two sizes a card is exported in. */
export const CARD_SIZES = {
  landscape: { width: 1920, height: 1080 },
  portrait: { width: 1080, height: 1920 },
};

export const goalType = (id) => GOAL_TYPES.find((type) => type.id === id) ?? GOAL_TYPES[0];
export const redType = (id) => RED_TYPES.find((type) => type.id === id) ?? RED_TYPES[0];

/** A minute as it is written on a card: 12' or 45+2'. */
export function minuteLabel(minute, added) {
  if (minute === null || minute === undefined || minute === '') return '';
  return `${minute}${added ? `+${added}` : ''}'`;
}
