/**
 * The principal IS the channel. There is no org and no user here: every
 * storage row, schedule and limit counter partitions on the channel id alone,
 * which is exactly the isolation an ambient agent needs — one channel can
 * never see another's state, monologue or budget.
 */
export interface Principal {
  channel: string;
}

export const owner = (p: Principal): string[] => [p.channel];
