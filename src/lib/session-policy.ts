import type { Session } from './types.js';

export function canWarmSession(session: Pick<Session, 'isLive'>): boolean {
  return session.isLive;
}

export function markSessionUnwarmable(session: Session): Session {
  const warmStatus = session.warmStatus === 'warming' ? 'idle' : session.warmStatus;
  if (!session.selected && session.nextWarmAt === null && session.warmStatus === warmStatus) {
    return session;
  }

  return {
    ...session,
    selected: false,
    nextWarmAt: null,
    warmStatus,
  };
}
