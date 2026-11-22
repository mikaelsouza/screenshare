import {
  MAX_ROOM_SIZE,
  isValidRoomCode,
  parseInviteInput,
  type PeerId,
} from "@shared/protocol";
import {
  clearAllPersistedHostTokens,
  clearLegacySessionHostTokens,
  hasAnyPersistedHostTokens,
  readPersistedHostToken,
  removePersistedHostTokenIfMatching,
  runWithHostRoomsLock,
  writePersistedHostToken,
} from "../host-tokens";
import { describeInviteParseFailure } from "../ui-model";

export interface MemberRecord {
  name: string;
  sharing: boolean;
  host: boolean;
}

export interface StorageEnvironment {
  getLocalStorage: () => Storage | null;
  getSessionStorage: () => Storage | null;
  getLocks: () => LockManager | null;
  runBackground: (task: Promise<unknown>) => void;
  onForgetHostUiChange: () => void;
}

export type BootAction =
  | { kind: "none" }
  | { kind: "error"; message: string }
  | { kind: "reconnect-current"; password: string }
  | { kind: "enter-invite"; code: string; password: string }
  | { kind: "resume-saved"; code: string };

export interface ErrorClassification {
  friendly: string;
  severity: "fatal" | "warn" | "ignore" | "error";
  clearPendingKicks: boolean;
}

const SESSION_WIPING_ERRORS: ReadonlySet<string> = new Set([
  "kicked",
  "room-locked",
  "bad-password",
  "bad-room-code",
  "session-replaced",
  "forbidden-origin",
]);

const CREATOR_TOKEN_WIPING_ERRORS: ReadonlySet<string> = new Set([
  "kicked",
  "bad-room-code",
]);

const FRIENDLY_ERROR_TEMPLATES: Readonly<Record<string, (code: string) => string>> = {
  kicked: () => "You were removed from this room by its host.",
  "room-locked": (code) => `Room ${code} is locked. Ask its host to unlock it.`,
  "session-replaced": () => "Connected from another tab. This session was closed.",
  "bad-password": () => "Invalid or expired room invite.",
  "join-timeout": () => "Connection timed out while joining the room. Please try again.",
  "connection-failed": () => "Could not connect to that room. Check your connection and try again.",
  "bad-message": () => "Disconnected due to a protocol error. Please rejoin the room.",
};

/**
 * Pure, DOM-free controller for room lifecycle, session/creator host token provenance,
 * rejoin tokens, URL `#fragment` boot resolution, pending kicks, and transient notices.
 */
export class SessionController {
  private readonly env: StorageEnvironment;
  private readonly memorySession = new Map<string, string>();
  private readonly creatorHostTokens = new Map<string, string>();
  private readonly sessionHostTokens = new Map<string, string>();
  private readonly pendingForgets = new Map<string, Map<number, string | null>>();
  readonly members: Map<PeerId, MemberRecord> = new Map<PeerId, MemberRecord>();
  private readonly pendingKicks = new Map<PeerId, { name: string; timer: ReturnType<typeof setTimeout> }>();

  selfId: PeerId | null = null;
  isHost: boolean = false;
  roomLocked: boolean = false;
  roomPassword: string | null = null;
  lastJoinCode: string | null = null;
  joinGeneration: number = 0;
  private forgetGen = 0;
  private pendingForgetAll = 0;
  private transientNoticeTimer: ReturnType<typeof setTimeout> | null = null;
  private activeTransientNotice: string | null = null;

  constructor(env: StorageEnvironment) {
    this.env = env;
  }

  get currentTransientNotice(): string | null {
    return this.activeTransientNotice;
  }

  readSession(key: string): string | undefined {
    const cached = this.memorySession.get(key);
    if (cached !== undefined) return cached;
    try {
      return this.env.getSessionStorage()?.getItem(key) ?? undefined;
    } catch {
      return undefined;
    }
  }

  writeSession(key: string, value: string | undefined): void {
    if (value !== undefined) this.memorySession.set(key, value);
    else this.memorySession.delete(key);
    try {
      const store = this.env.getSessionStorage();
      if (!store) return;
      if (value !== undefined) store.setItem(key, value);
      else store.removeItem(key);
    } catch {
      /* sessionStorage unavailable */
    }
  }

  activeRoomFor(): string | undefined {
    return this.readSession("activeRoom");
  }

  saveActiveRoom(code: string | undefined): void {
    this.writeSession("activeRoom", code);
  }

  rejoinTokenFor(code: string): string | undefined {
    return this.readSession(`rejoin:${code}`);
  }

  saveRejoinToken(code: string, token: string | undefined): void {
    this.writeSession(`rejoin:${code}`, token);
  }

  private readAllowedPersistedHostToken(code: string): string | undefined {
    if (this.pendingForgetAll > 0) return undefined;
    const persisted = readPersistedHostToken(this.env.getLocalStorage(), code);
    if (persisted === undefined) return undefined;
    const pending = this.pendingForgets.get(code);
    if (pending) {
      for (const match of pending.values()) {
        if (match === null || match === persisted) return undefined;
      }
    }
    return persisted;
  }

  hasSavedCreatorHostFor(code: string): boolean {
    return this.creatorHostTokens.has(code) || this.readAllowedPersistedHostToken(code) !== undefined;
  }

  hasAnySavedCreatorHosts(): boolean {
    return (
      this.creatorHostTokens.size > 0 ||
      (this.pendingForgetAll === 0 && hasAnyPersistedHostTokens(this.env.getLocalStorage()))
    );
  }

  saveCreatorHostToken(code: string, token: string): void {
    this.pendingForgets.delete(code);
    this.creatorHostTokens.set(code, token);
    this.env.onForgetHostUiChange();
    this.env.runBackground(
      runWithHostRoomsLock(this.env.getLocks(), () => {
        writePersistedHostToken(this.env.getLocalStorage(), code, token);
        this.env.onForgetHostUiChange();
      }),
    );
  }

  saveSessionHostToken(code: string, token: string): void {
    this.sessionHostTokens.set(code, token);
    this.env.onForgetHostUiChange();
  }

  deleteSessionHostToken(code: string): void {
    this.sessionHostTokens.delete(code);
  }

  forgetCreatorHostToken(code: string, onlyIfMatching?: string): void {
    if (onlyIfMatching === undefined || this.sessionHostTokens.get(code) === onlyIfMatching) {
      this.sessionHostTokens.delete(code);
    }
    if (onlyIfMatching === undefined || this.creatorHostTokens.get(code) === onlyIfMatching) {
      this.creatorHostTokens.delete(code);
    }
    if (onlyIfMatching === undefined) this.writeSession(`host:${code}`, undefined);
    const gen = ++this.forgetGen;
    let pending = this.pendingForgets.get(code);
    if (!pending) {
      pending = new Map();
      this.pendingForgets.set(code, pending);
    }
    pending.set(gen, onlyIfMatching ?? null);
    this.env.onForgetHostUiChange();
    this.env.runBackground(
      runWithHostRoomsLock(this.env.getLocks(), () => {
        try {
          if (onlyIfMatching !== undefined) {
            removePersistedHostTokenIfMatching(this.env.getLocalStorage(), code, onlyIfMatching);
          } else {
            writePersistedHostToken(this.env.getLocalStorage(), code, undefined);
          }
        } finally {
          const entry = this.pendingForgets.get(code);
          if (entry) {
            entry.delete(gen);
            if (entry.size === 0) this.pendingForgets.delete(code);
          }
        }
        this.env.onForgetHostUiChange();
      }),
    );
  }

  forgetAllHostTokens(): void {
    this.creatorHostTokens.clear();
    this.sessionHostTokens.clear();
    for (const key of [...this.memorySession.keys()]) {
      if (key.startsWith("host:")) this.memorySession.delete(key);
    }
    clearLegacySessionHostTokens(this.env.getSessionStorage());
    this.pendingForgetAll++;
    this.env.onForgetHostUiChange();
    this.env.runBackground(
      runWithHostRoomsLock(this.env.getLocks(), () => {
        try {
          clearAllPersistedHostTokens(this.env.getLocalStorage());
        } finally {
          this.pendingForgetAll = Math.max(0, this.pendingForgetAll - 1);
        }
        this.env.onForgetHostUiChange();
      }),
    );
  }

  hostTokenFor(code: string): string | undefined {
    const promoted = this.sessionHostTokens.get(code);
    if (promoted !== undefined) return promoted;
    const inMemoryCreator = this.creatorHostTokens.get(code);
    if (inMemoryCreator !== undefined) return inMemoryCreator;
    const persisted = this.readAllowedPersistedHostToken(code);
    if (persisted !== undefined) {
      this.creatorHostTokens.set(code, persisted);
      return persisted;
    }
    const legacy = this.readSession(`host:${code}`);
    if (legacy !== undefined) {
      this.writeSession(`host:${code}`, undefined);
      this.saveCreatorHostToken(code, legacy);
      return legacy;
    }
    return undefined;
  }

  syncCreatorTokensFromStorage(): void {
    const storage = this.env.getLocalStorage();
    for (const code of [...this.creatorHostTokens.keys()]) {
      const current = readPersistedHostToken(storage, code);
      if (current === undefined) {
        this.creatorHostTokens.delete(code);
      } else {
        this.creatorHostTokens.set(code, current);
      }
    }
    this.env.onForgetHostUiChange();
  }

  clearRoomSession(code?: string): void {
    const target = code ?? this.lastJoinCode ?? this.activeRoomFor();
    this.saveActiveRoom(undefined);
    if (!target) return;
    this.sessionHostTokens.delete(target);
    this.saveRejoinToken(target, undefined);
  }

  connectedRoomStatusText(code: string): string {
    return `In room ${code} \u2014 ${this.members.size + 1}/${MAX_ROOM_SIZE} connected`;
  }

  clearTransientNoticeTimer(): void {
    if (this.transientNoticeTimer !== null) {
      clearTimeout(this.transientNoticeTimer);
      this.transientNoticeTimer = null;
    }
  }

  clearTransientNoticeState(): void {
    this.clearTransientNoticeTimer();
    this.activeTransientNotice = null;
  }

  dismissTransientNotice(
    currentStatusText: string,
    isConnectedReady: boolean,
    onRestore: (statusText: string) => void,
  ): void {
    this.clearTransientNoticeTimer();
    if (
      this.activeTransientNotice !== null &&
      currentStatusText === this.activeTransientNotice &&
      isConnectedReady &&
      this.selfId !== null &&
      this.lastJoinCode !== null
    ) {
      onRestore(this.connectedRoomStatusText(this.lastJoinCode));
    }
    this.activeTransientNotice = null;
  }

  showTransientNotice(
    message: string,
    onShow: (msg: string) => void,
    onExpire: (msg: string) => void,
    durationMs = 6_000,
  ): void {
    this.clearTransientNoticeTimer();
    this.activeTransientNotice = message;
    onShow(message);
    this.transientNoticeTimer = setTimeout(() => {
      this.transientNoticeTimer = null;
      if (this.activeTransientNotice === message) {
        onExpire(message);
        this.activeTransientNotice = null;
      }
    }, durationMs);
  }

  hasPendingKick(peerId: PeerId): boolean {
    return this.pendingKicks.has(peerId);
  }

  startPendingKick(peerId: PeerId, name: string, onTimeout: () => void, timeoutMs = 10_000): boolean {
    if (this.pendingKicks.has(peerId)) return false;
    const timer = setTimeout(() => {
      this.pendingKicks.delete(peerId);
      onTimeout();
    }, timeoutMs);
    this.pendingKicks.set(peerId, { name, timer });
    return true;
  }

  consumePendingKick(peerId: PeerId): string | null {
    const pending = this.pendingKicks.get(peerId);
    if (!pending) return null;
    clearTimeout(pending.timer);
    this.pendingKicks.delete(peerId);
    return pending.name;
  }

  clearPendingKicks(): void {
    for (const pending of this.pendingKicks.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingKicks.clear();
  }

  applyWelcomeCredentials(
    code: string,
    room: { host: boolean; hostToken?: string; rejoinToken?: string; password?: string; locked: boolean },
    lastPresentedHostToken: string | undefined,
  ): { hideInvite: boolean } {
    if (!room.host) {
      this.sessionHostTokens.delete(code);
      this.env.onForgetHostUiChange();
    } else if (room.hostToken) {
      this.saveSessionHostToken(code, room.hostToken);
    } else {
      const knownCreator =
        this.creatorHostTokens.get(code) ?? readPersistedHostToken(this.env.getLocalStorage(), code);
      if (lastPresentedHostToken !== undefined && lastPresentedHostToken === knownCreator) {
        this.saveCreatorHostToken(code, knownCreator);
      }
    }
    this.saveRejoinToken(code, room.rejoinToken);
    if (room.password) {
      this.roomPassword = room.password;
      return { hideInvite: false };
    }
    if (room.locked && !room.host) {
      this.roomPassword = null;
      return { hideInvite: true };
    }
    return { hideInvite: false };
  }

  applyRoomState(locked: boolean, password?: string): void {
    this.roomLocked = locked;
    if (locked) {
      if (!this.isHost) this.roomPassword = null;
    } else if (password) {
      this.roomPassword = password;
    }
  }

  applyRoomPassword(code: string, password?: string, rejoinToken?: string): void {
    if (rejoinToken !== undefined) {
      this.saveRejoinToken(code, rejoinToken);
    }
    if (password !== undefined) {
      this.roomPassword = password;
    } else if (this.roomLocked && !this.isHost) {
      this.roomPassword = null;
    }
  }

  applyHostPromoted(code: string, hostId: PeerId, hostToken?: string, password?: string): void {
    this.isHost = hostId === this.selfId;
    for (const [id, m] of this.members) {
      m.host = id === hostId;
    }
    if (this.isHost) {
      if (hostToken) this.saveSessionHostToken(code, hostToken);
      if (password) this.roomPassword = password;
    }
  }

  classifyError(
    codeToJoin: string,
    codeErr: string,
    message: string,
    isFatal: boolean,
  ): ErrorClassification {
    const template = FRIENDLY_ERROR_TEMPLATES[codeErr];
    const friendly = template ? template(codeToJoin) : message;
    if (isFatal) {
      return { friendly, severity: "fatal", clearPendingKicks: true };
    }
    if (codeErr === "not-host") {
      return { friendly, severity: "warn", clearPendingKicks: true };
    }
    if (
      codeErr === "unknown-peer" ||
      codeErr === "not-sharing" ||
      codeErr === "chat-rate-limited"
    ) {
      return { friendly, severity: "ignore", clearPendingKicks: codeErr === "unknown-peer" };
    }
    const formatted = codeErr === "rate-limited" ? friendly : `${codeErr}: ${friendly}`;
    return { friendly: formatted, severity: "error", clearPendingKicks: true };
  }

  applyFatalErrorCleanup(
    codeToJoin: string,
    codeErr: string,
    hasWelcomed: boolean,
    lastPresentedHostToken: string | undefined,
    forgetCreatorToken: boolean = true,
  ): void {
    if (SESSION_WIPING_ERRORS.has(codeErr)) {
      this.clearRoomSession(codeToJoin);
    } else if (!hasWelcomed) {
      this.saveActiveRoom(undefined);
    }
    if (codeErr === "bad-password" || CREATOR_TOKEN_WIPING_ERRORS.has(codeErr)) {
      this.sessionHostTokens.delete(codeToJoin);
    }
    if (forgetCreatorToken && CREATOR_TOKEN_WIPING_ERRORS.has(codeErr)) {
      if (lastPresentedHostToken !== undefined) {
        this.forgetCreatorHostToken(codeToJoin, lastPresentedHostToken);
      } else {
        this.env.onForgetHostUiChange();
      }
    }
    this.lastJoinCode = null;
  }

  resolveBootAction(
    rawHash: string,
    isHashChange: boolean,
    clientState: { active: boolean; fatal: boolean; ready: boolean },
  ): BootAction {
    if (rawHash.length > 0) {
      const parsed = parseInviteInput(rawHash);
      if (!parsed.ok) {
        return { kind: "error", message: describeInviteParseFailure(parsed.reason) };
      }
      if (this.lastJoinCode === parsed.code && this.selfId !== null && clientState.active && !clientState.fatal) {
        if (!clientState.ready) {
          this.roomPassword = parsed.password;
          return { kind: "reconnect-current", password: parsed.password };
        }
        return { kind: "none" };
      }
      return { kind: "enter-invite", code: parsed.code, password: parsed.password };
    }

    if (isHashChange) return { kind: "none" };
    const savedRoom = this.activeRoomFor();
    if (
      savedRoom &&
      isValidRoomCode(savedRoom) &&
      Boolean(this.rejoinTokenFor(savedRoom) ?? this.hostTokenFor(savedRoom))
    ) {
      return { kind: "resume-saved", code: savedRoom };
    }
    if (savedRoom) {
      this.clearRoomSession(savedRoom);
    }
    return { kind: "none" };
  }

  resetRoomState(): void {
    this.clearPendingKicks();
    this.clearTransientNoticeState();
    this.members.clear();
    this.selfId = null;
    this.isHost = false;
    this.roomLocked = false;
    this.roomPassword = null;
  }
}
