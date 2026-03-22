export type SavedLogin = {
  username: string;
  hash: string;
};

const SAVED_LOGIN_KEY = "rxdbwb_saved_login";
const MANUAL_LOGOUT_KEY = "rxdbwb_manual_logout";

export function getSavedLogin(): SavedLogin | null {
  try {
    const raw = window.localStorage.getItem(SAVED_LOGIN_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<SavedLogin>;
    if (typeof parsed.username !== "string" || typeof parsed.hash !== "string") {
      return null;
    }

    return { username: parsed.username, hash: parsed.hash };
  } catch {
    return null;
  }
}

export function saveSavedLogin(value: SavedLogin): void {
  window.localStorage.setItem(SAVED_LOGIN_KEY, JSON.stringify(value));
}

export function clearSavedLogin(): void {
  window.localStorage.removeItem(SAVED_LOGIN_KEY);
}

export function isManualLogout(): boolean {
  return window.localStorage.getItem(MANUAL_LOGOUT_KEY) === "1";
}

export function markManualLogout(): void {
  window.localStorage.setItem(MANUAL_LOGOUT_KEY, "1");
}

export function clearManualLogout(): void {
  window.localStorage.removeItem(MANUAL_LOGOUT_KEY);
}