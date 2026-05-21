export interface ConnectedSsoSession {
  ssoSession: string;
  ssoRegion: string;
  accessToken: string;
  expiresAt?: Date;
}

const store = new Map<string, ConnectedSsoSession>();

export function setSsoSession(
  sessionId: string,
  session: ConnectedSsoSession
): void {
  store.set(sessionId, session);
}

export function getSsoSession(
  sessionId: string
): ConnectedSsoSession | undefined {
  const value = store.get(sessionId);
  if (!value) return undefined;

  if (value.expiresAt && value.expiresAt.getTime() <= Date.now()) {
    store.delete(sessionId);
    return undefined;
  }

  return value;
}
