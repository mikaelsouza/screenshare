import { describe, expect, it, vi } from "vitest";
import { InviteController } from "@src/controllers/invite-controller";
import { PopoverToastController } from "@src/controllers/popover-toast-controller";
import { RecentRoomsController } from "@src/controllers/recent-rooms-controller";
import { SessionController } from "@src/controllers/session-controller";
import { TileController } from "@src/controllers/tile-controller";
import { readPersistedHostToken, writePersistedHostToken } from "@src/host-tokens";
import { loadRecentRooms } from "@src/recent-rooms";
import type { UiElements } from "@src/views/dom";
import { RecentRoomsView } from "@src/views/recent-rooms-view";
import { buildSignalingHandlers, type RoomWiringContext } from "@src/views/room-wiring";
import type { TileView } from "@src/views/tile-view";

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key) {
      return store.get(key) ?? null;
    },
    key(index) {
      return [...store.keys()][index] ?? null;
    },
    removeItem(key) {
      store.delete(key);
    },
    setItem(key, value) {
      store.set(key, value);
    },
  };
}

function makeWiringHarness(options?: {
  code?: string;
  lastHostToken?: string | undefined;
}) {
  const code = options?.code ?? "WXYZ2345";
  const storage = createMemoryStorage();
  const sessStorage = createMemoryStorage();
  const tasks: Promise<unknown>[] = [];
  const lobbyErrors: Array<string | null> = [];
  let recentRooms!: RecentRoomsController;

  const session = new SessionController({
    getLocalStorage: () => storage,
    getSessionStorage: () => sessStorage,
    getLocks: () => null,
    runBackground: (t) => {
      tasks.push(t);
    },
    onForgetHostUiChange: () => {
      recentRooms.syncFromStorage();
    },
  });
  recentRooms = new RecentRoomsController({
    getLocalStorage: () => storage,
    getLocks: () => null,
    runBackground: (t) => {
      tasks.push(t);
    },
    hasSavedCreatorHostFor: (c) => session.hasSavedCreatorHostFor(c),
    onRemoveHostToken: (c) => session.forgetCreatorHostToken(c),
    onForgetAllHostTokens: () => session.forgetAllHostTokens(),
    onChange: vi.fn(),
  });

  const ctx: RoomWiringContext = {
    ui: {
      roomInput: { value: code },
      nameInput: { value: "Tester" },
      roomNameInput: { value: "Tester" },
    } as unknown as UiElements,
    session,
    recentRooms,
    invite: new InviteController({ onChange: vi.fn() }),
    tileCtrl: new TileController(),
    popovers: new PopoverToastController({ onJoinChipChange: vi.fn() }),
    tileView: {
      videoPeerIds: () => [],
      getVideo: () => undefined,
      removeTile: vi.fn(),
      updateTileLabel: vi.fn(),
      renderSelfPreview: vi.fn(),
    } as unknown as TileView,
    health: { start: vi.fn(), clearAll: vi.fn() } as unknown as RoomWiringContext["health"],
    peerLeftTimers: new Map(),
    chat: {
      onMessage: vi.fn(),
      onRateLimited: vi.fn(),
      syncReady: vi.fn(),
      onFreshWelcome: vi.fn(),
    },
    getClient: () => ({ isReady: true, isFatal: true, setSharing: vi.fn(), signal: vi.fn() }) as unknown as ReturnType<RoomWiringContext["getClient"]>,
    getMesh: () => null,
    setMesh: vi.fn(),
    getCapture: () => null,
    isFocusedAndVisible: () => true,
    setStatus: vi.fn(),
    setLobbyError: (msg) => {
      lobbyErrors.push(msg);
    },
    showTransientRoomNotice: vi.fn(),
    scrubRoomUrl: vi.fn(),
    teardownPeer: vi.fn(),
    renderInviteMenu: vi.fn(),
    renderRoster: vi.fn(),
    renderJoinChip: vi.fn(),
    syncViewState: vi.fn(),
    stopSharing: vi.fn().mockResolvedValue(undefined),
    leaveRoom: vi.fn(),
  };

  const handlers = buildSignalingHandlers(
    ctx,
    code,
    session.joinGeneration,
    () => options?.lastHostToken,
  );

  return {
    code,
    storage,
    tasks,
    session,
    recentRooms,
    handlers,
    lobbyErrors,
  };
}

describe("room-wiring recent rooms integration", () => {
  it("refreshes recent-rooms password on room-password even while roomLocked is true", async () => {
    const h = makeWiringHarness({ code: "MNPQ2345", lastHostToken: "tok-host" });
    h.session.saveCreatorHostToken("MNPQ2345", "tok-host");

    h.handlers.onWelcome("self-1", [], {
      host: true,
      locked: false,
      password: "INITIAL_PASS_111",
    });
    expect(h.recentRooms.getRooms()[0]?.password).toBe("INITIAL_PASS_111");

    // room-state(locked=true) with no password retains last known password
    h.handlers.onRoomState?.(true, undefined);
    expect(h.session.roomLocked).toBe(true);
    expect(h.recentRooms.getRooms()[0]?.password).toBe("INITIAL_PASS_111");

    // Host rotates invite / kicks peer while locked -> room-password updates recent-rooms
    h.handlers.onRoomPassword?.("ROTATED_PASS_222", "rejoin-2");
    expect(h.recentRooms.getRooms()[0]?.password).toBe("ROTATED_PASS_222");

    // room-password without password while locked retains rotated password
    h.handlers.onRoomPassword?.(undefined, "rejoin-3");
    expect(h.recentRooms.getRooms()[0]?.password).toBe("ROTATED_PASS_222");

    // Forgetting host demotes to guest and keeps the rotated password
    h.session.forgetCreatorHostToken("MNPQ2345");
    h.recentRooms.handleCreatorHostForgotten("MNPQ2345");
    await Promise.all(h.tasks);

    expect(h.recentRooms.getRooms()[0]?.role).toBe("guest");
    expect(h.recentRooms.getRooms()[0]?.password).toBe("ROTATED_PASS_222");
    expect(loadRecentRooms(h.storage)[0]?.password).toBe("ROTATED_PASS_222");
  });

  it("reports Removed CODE notice and prevents resurrection on bad-password/kicked for legacy host-rooms entries even when lastHostToken is undefined", async () => {
    for (const [errCode, expectedSubstr] of [
      ["bad-password", "Invalid or expired room invite"],
      ["kicked", "removed"],
    ] as const) {
      const h = makeWiringHarness({ code: "WXYZ2345", lastHostToken: undefined });
      writePersistedHostToken(h.storage, "WXYZ2345", "legacy-host-tok", Date.now());
      h.session.syncCreatorTokensFromStorage();
      h.recentRooms.syncFromStorage();
      expect(h.recentRooms.getRooms().map((r) => r.code)).toEqual(["WXYZ2345"]);

      h.handlers.onError(errCode, errCode);
      await Promise.all(h.tasks);
      h.recentRooms.syncFromStorage();

      const lastErr = h.lobbyErrors[h.lobbyErrors.length - 1] ?? "";
      expect(lastErr).toContain(expectedSubstr);
      expect(lastErr).toContain("Removed WXYZ2345 from saved rooms.");
      expect(h.recentRooms.getRooms()).toEqual([]);
      expect(readPersistedHostToken(h.storage, "WXYZ2345")).toBeUndefined();
      expect(loadRecentRooms(h.storage)).toEqual([]);
    }
  });

  it("preserves unsaved rename draft, focus, and caret across simulated cross-tab updates in RecentRoomsView", () => {
    withFakeRecentRoomsDom(({ root, view, docState, findRenameInput }) => {
      const t0 = 1_700_000_000_000;
      const r1 = { code: "AAAA2345", role: "host" as const, lastJoinedAt: t0, peerNames: [], label: "Saved" };
      const r2 = { code: "BBBB2345", role: "guest" as const, lastJoinedAt: t0 - 1000, peerNames: [] };
      const r3 = { code: "CCCC2345", role: "guest" as const, lastJoinedAt: t0 - 2000, peerNames: [] };

      // Start inline rename on AAAA2345 (2 rooms -> "few" mode)
      view.render({
        disabled: false,
        totalCount: 2,
        filteredRooms: [r1, r2],
        searchQuery: "",
        editingCode: "AAAA2345",
      });
      const input1 = findRenameInput(root);
      expect(input1).not.toBeNull();
      expect(input1?.focusCalls).toBe(1);
      expect(input1?.selectCalls).toBe(1);

      // User edits draft and places caret at index 4
      if (input1) {
        input1.value = "Draft Name";
        input1.selectionStart = 4;
        input1.selectionEnd = 4;
      }

      // Simulated cross-tab storage update adds a 3rd room ("few" -> "many" mode transition) while editingCode stays active
      view.render({
        disabled: false,
        totalCount: 3,
        filteredRooms: [{ ...r1, label: "OtherTab" }, r2, r3],
        searchQuery: "",
        editingCode: "AAAA2345",
      });
      const input2 = findRenameInput(root);
      expect(input2).not.toBeNull();
      expect(input2).not.toBe(input1);
      expect(input2?.value).toBe("Draft Name");
      expect(docState.activeElement).toBe(input2);
      expect(input2?.selectionRestores).toEqual([[4, 4]]);

      // Simulated external deletion clears editingCode -> rename input removed and draft state cleared
      view.render({
        disabled: false,
        totalCount: 2,
        filteredRooms: [r2, r3],
        searchQuery: "",
        editingCode: null,
      });
      expect(findRenameInput(root)).toBeNull();
    });
  });

  it("preserves unsaved rename draft and keeps focus on #recent-rooms-search when filter hides and unhides the edited row", () => {
    withFakeRecentRoomsDom(({ root, view, docState, findRenameInput, findById }) => {
      const t0 = 1_700_000_000_000;
      const r1 = { code: "AAAA2345", role: "host" as const, lastJoinedAt: t0, peerNames: [], label: "OldLabel" };
      const r2 = { code: "BBBB2345", role: "guest" as const, lastJoinedAt: t0 - 1000, peerNames: [] };
      const r3 = { code: "CCCC2345", role: "guest" as const, lastJoinedAt: t0 - 2000, peerNames: [] };

      view.render({
        disabled: false,
        totalCount: 3,
        filteredRooms: [r1, r2, r3],
        searchQuery: "",
        editingCode: "AAAA2345",
      });
      const input1 = findRenameInput(root);
      expect(input1).not.toBeNull();
      if (input1) {
        input1.value = "UnsavedDraft";
        input1.selectionStart = 2;
        input1.selectionEnd = 7;
      }

      const searchInput = findById(root, "recent-rooms-search");
      expect(searchInput).not.toBeNull();
      searchInput?.focus();
      expect(docState.activeElement).toBe(searchInput);

      // User filters out AAAA2345 while keeping focus in #recent-rooms-search
      view.render({
        disabled: false,
        totalCount: 3,
        filteredRooms: [r2],
        searchQuery: "BBBB",
        editingCode: "AAAA2345",
      });
      expect(findRenameInput(root)).toBeNull();
      expect(docState.activeElement).toBe(searchInput);

      // User clears filter -> AAAA2345 reappears with draft and selection intact, without stealing focus
      view.render({
        disabled: false,
        totalCount: 3,
        filteredRooms: [r1, r2, r3],
        searchQuery: "",
        editingCode: "AAAA2345",
      });
      const input2 = findRenameInput(root);
      expect(input2).not.toBeNull();
      expect(input2?.value).toBe("UnsavedDraft");
      expect(input2?.selectionRestores).toEqual([[2, 7]]);
      expect(input2?.focusCalls).toBe(0);
      expect(input2?.selectCalls).toBe(0);
      expect(docState.activeElement).toBe(searchInput);
    });
  });

  it("preserves unsaved rename draft when cross-tab metadata hides edited row under active searchQuery and does not steal focus when cleared", () => {
    withFakeRecentRoomsDom(({ root, view, docState, findRenameInput, findById }) => {
      const t0 = 1_700_000_000_000;
      const r1 = { code: "AAAA2345", role: "host" as const, lastJoinedAt: t0, peerNames: [], label: "MatchLabel" };
      const r2 = { code: "BBBB2345", role: "guest" as const, lastJoinedAt: t0 - 1000, peerNames: [] };
      const r3 = { code: "CCCC2345", role: "guest" as const, lastJoinedAt: t0 - 2000, peerNames: [] };

      view.render({
        disabled: false,
        totalCount: 3,
        filteredRooms: [r1],
        searchQuery: "Match",
        editingCode: "AAAA2345",
      });
      const input1 = findRenameInput(root);
      expect(input1).not.toBeNull();
      expect(docState.activeElement).toBe(input1);
      if (input1) input1.value = "MyLocalRename";

      // Cross-tab metadata update changes label to "OtherLabel", hiding row under searchQuery="Match"
      view.render({
        disabled: false,
        totalCount: 3,
        filteredRooms: [],
        searchQuery: "Match",
        editingCode: "AAAA2345",
      });
      expect(findRenameInput(root)).toBeNull();

      // User focuses #recent-rooms-search to clear the filter
      const searchInput = findById(root, "recent-rooms-search");
      expect(searchInput).not.toBeNull();
      searchInput?.focus();
      view.render({
        disabled: false,
        totalCount: 3,
        filteredRooms: [{ ...r1, label: "OtherLabel" }, r2, r3],
        searchQuery: "",
        editingCode: "AAAA2345",
      });
      const input2 = findRenameInput(root);
      expect(input2).not.toBeNull();
      expect(input2?.value).toBe("MyLocalRename");
      expect(input2?.focusCalls).toBe(0);
      expect(docState.activeElement).toBe(searchInput);
    });
  });

  it("clears retained hidden rename draft on external deletion or switching editingCode", () => {
    withFakeRecentRoomsDom(({ root, view, findRenameInput, findById }) => {
      const t0 = 1_700_000_000_000;
      const r1 = { code: "AAAA2345", role: "host" as const, lastJoinedAt: t0, peerNames: [], label: "Alpha" };
      const r2 = { code: "BBBB2345", role: "guest" as const, lastJoinedAt: t0 - 1000, peerNames: [], label: "Beta" };
      const r3 = { code: "CCCC2345", role: "guest" as const, lastJoinedAt: t0 - 2000, peerNames: [], label: "Gamma" };

      // Case 1: external deletion (editingCode: null) while hidden clears draft
      view.render({
        disabled: false,
        totalCount: 3,
        filteredRooms: [r1, r2, r3],
        searchQuery: "",
        editingCode: "AAAA2345",
      });
      const input1 = findRenameInput(root);
      if (input1) input1.value = "StaleDraft";
      findById(root, "recent-rooms-search")?.focus();
      view.render({
        disabled: false,
        totalCount: 3,
        filteredRooms: [r2],
        searchQuery: "BBBB",
        editingCode: "AAAA2345",
      });
      view.render({
        disabled: false,
        totalCount: 2,
        filteredRooms: [r2, r3],
        searchQuery: "",
        editingCode: null,
      });
      view.render({
        disabled: false,
        totalCount: 3,
        filteredRooms: [{ ...r1, label: "FreshAlpha" }, r2, r3],
        searchQuery: "",
        editingCode: "AAAA2345",
      });
      const afterDeleteInput = findRenameInput(root);
      expect(afterDeleteInput?.value).toBe("FreshAlpha");
      expect(afterDeleteInput?.focusCalls).toBe(1);
      expect(afterDeleteInput?.selectCalls).toBe(1);

      // Case 2: switching editingCode while hidden discards previous room's retained draft
      if (afterDeleteInput) afterDeleteInput.value = "DraftA";
      findById(root, "recent-rooms-search")?.focus();
      view.render({
        disabled: false,
        totalCount: 3,
        filteredRooms: [r3],
        searchQuery: "CCCC",
        editingCode: "AAAA2345",
      });
      view.render({
        disabled: false,
        totalCount: 3,
        filteredRooms: [r3],
        searchQuery: "CCCC",
        editingCode: "CCCC2345",
      });
      const inputC = findRenameInput(root);
      expect(inputC?.value).toBe("Gamma");
      expect(inputC?.focusCalls).toBe(1);
      expect(inputC?.selectCalls).toBe(1);

      view.render({
        disabled: false,
        totalCount: 3,
        filteredRooms: [r1, r2, r3],
        searchQuery: "",
        editingCode: "AAAA2345",
      });
      const freshA = findRenameInput(root);
      expect(freshA?.value).toBe("Alpha");
    });
  });

  it("does not throw on render when minimal Fake DOM input lacks select() and setSelectionRange()", () => {
    withFakeRecentRoomsDom(
      ({ root, view, findRenameInput }) => {
        const t0 = 1_700_000_000_000;
        const r1 = { code: "AAAA2345", role: "host" as const, lastJoinedAt: t0, peerNames: [], label: "One" };
        const r2 = { code: "BBBB2345", role: "guest" as const, lastJoinedAt: t0 - 1000, peerNames: [] };
        const r3 = { code: "CCCC2345", role: "guest" as const, lastJoinedAt: t0 - 2000, peerNames: [] };

        expect(() => {
          view.render({
            disabled: false,
            totalCount: 2,
            filteredRooms: [r1, r2],
            searchQuery: "",
            editingCode: "AAAA2345",
          });
        }).not.toThrow();

        const input1 = findRenameInput(root);
        expect(input1).not.toBeNull();
        if (input1) input1.value = "MinimalDraft";

        expect(() => {
          view.render({
            disabled: false,
            totalCount: 3,
            filteredRooms: [r1, r2, r3],
            searchQuery: "",
            editingCode: "AAAA2345",
          });
        }).not.toThrow();

        const input2 = findRenameInput(root);
        expect(input2?.value).toBe("MinimalDraft");
      },
      { minimalInput: true },
    );
  });
});

interface FakeRecentDomEl {
  id: string;
  tagName: string;
  className: string;
  textContent: string;
  hidden: boolean;
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  dataset: Record<string, string>;
  children: FakeRecentDomEl[];
  focusCalls: number;
  selectCalls: number;
  selectionRestores: Array<[number, number]>;
  classList: { toggle: (name: string, force?: boolean) => void };
  append: (...nodes: FakeRecentDomEl[]) => void;
  replaceChildren: (...nodes: FakeRecentDomEl[]) => void;
  setAttribute: (_k: string, _v: string) => void;
  addEventListener: (_type: string, _fn: (...args: unknown[]) => void) => void;
  focus: () => void;
  select?: () => void;
  setSelectionRange?: (start: number, end: number) => void;
}

function withFakeRecentRoomsDom(
  fn: (ctx: {
    root: FakeRecentDomEl;
    view: RecentRoomsView;
    docState: { activeElement: FakeRecentDomEl | null };
    findRenameInput: (root: FakeRecentDomEl) => FakeRecentDomEl | null;
    findById: (root: FakeRecentDomEl, id: string) => FakeRecentDomEl | null;
  }) => void,
  options?: { minimalInput?: boolean },
): void {
  const docState: { activeElement: FakeRecentDomEl | null } = { activeElement: null };
  const makeEl = (tag: string): FakeRecentDomEl => {
    const classes = new Set<string>();
    const node: FakeRecentDomEl = {
      id: "",
      tagName: tag.toUpperCase(),
      className: "",
      textContent: "",
      hidden: false,
      value: "",
      selectionStart: null,
      selectionEnd: null,
      dataset: {},
      children: [],
      focusCalls: 0,
      selectCalls: 0,
      selectionRestores: [],
      classList: {
        toggle: (name, force) => {
          if (force === undefined) {
            if (classes.has(name)) classes.delete(name);
            else classes.add(name);
          } else if (force) {
            classes.add(name);
          } else {
            classes.delete(name);
          }
        },
      },
      append: (...nodes) => {
        node.children.push(...nodes);
      },
      replaceChildren: (...nodes) => {
        node.children = [...nodes];
      },
      setAttribute: () => {},
      addEventListener: () => {},
      focus: () => {
        node.focusCalls += 1;
        docState.activeElement = node;
      },
    };
    if (!options?.minimalInput) {
      node.select = () => {
        node.selectCalls += 1;
      };
      node.setSelectionRange = (start, end) => {
        node.selectionStart = start;
        node.selectionEnd = end;
        node.selectionRestores.push([start, end]);
      };
    }
    return node;
  };

  const findRenameInput = (root: FakeRecentDomEl): FakeRecentDomEl | null => {
    for (const child of root.children) {
      if (child.tagName === "INPUT" && child.className.includes("recent-room-rename-input")) return child;
      const nested = findRenameInput(child);
      if (nested) return nested;
    }
    return null;
  };

  const findById = (root: FakeRecentDomEl, id: string): FakeRecentDomEl | null => {
    for (const child of root.children) {
      if (child.id === id) return child;
      const nested = findById(child, id);
      if (nested) return nested;
    }
    return null;
  };

  const prevDoc = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = {
    get activeElement() {
      return docState.activeElement;
    },
    createElement: (tag: string) => makeEl(tag),
  };

  try {
    const lobbyCard = makeEl("div");
    const root = makeEl("div");
    const view = new RecentRoomsView(
      lobbyCard as unknown as HTMLElement,
      root as unknown as HTMLElement,
      {
        onRejoin: vi.fn(),
        onStartRename: vi.fn(),
        onCommitRename: vi.fn(),
        onCancelRename: vi.fn(),
        onRemove: vi.fn(),
        onClearAll: vi.fn(),
        onSetDisabled: vi.fn(),
        onSearchChange: vi.fn(),
      },
    );
    fn({ root, view, docState, findRenameInput, findById });
  } finally {
    if (prevDoc === undefined) delete (globalThis as { document?: unknown }).document;
    else (globalThis as { document?: unknown }).document = prevDoc;
  }
}
