import type { VoteCounts } from '../observability/ledger';

/**
 * Lets a 👍/👎 button click on a finished reply card refresh that card's vote
 * counts. flushIM registers an `update` closure (which patches the managed
 * entity card via updateCardById, the reliable path) keyed by the card's
 * message id once the run completes; the dispatcher looks it up on click.
 *
 * Module-local because it's per-process UI glue — lost on restart, which is
 * fine: the click still records to the ledger (the button carries the entry
 * id), and native emoji reactions keep the authoritative persistent count.
 */
export interface FeedbackCard {
  entryId: string;
  update: (counts: VoteCounts) => Promise<void>;
}

const byMessageId = new Map<string, FeedbackCard>();
const MAX_TRACKED = 500;

export function registerFeedbackCard(messageId: string, card: FeedbackCard): void {
  if (byMessageId.size >= MAX_TRACKED) {
    const oldest = byMessageId.keys().next().value;
    if (oldest !== undefined) byMessageId.delete(oldest);
  }
  byMessageId.set(messageId, card);
}

export function getFeedbackCard(messageId: string): FeedbackCard | undefined {
  return byMessageId.get(messageId);
}
