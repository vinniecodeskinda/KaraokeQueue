// Audience reactions: phones send { emoji, name } as a Realtime Broadcast
// "react" message, and the TV floats them up the sides of the screen. Only
// emoji from this list are shown, so nobody can float arbitrary text on the TV.
export const REACTIONS = [
  // cheers
  '👏', '🔥', '😂', '❤️', '🎉', '🙌', '🤘', '💯', '😍', '🥳', '🕺', '🎤', '👍', '😮',
  // boos
  '👎', '💔', '🤮', '💀', '😞', '😢',
];

export const isReaction = (emoji) => REACTIONS.includes(emoji);
