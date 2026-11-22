import { afterEach, describe, expect, it, vi } from "vitest";
import { InviteController } from "@src/controllers/invite-controller";
import { PopoverToastController } from "@src/controllers/popover-toast-controller";
import { RecentRoomsController } from "@src/controllers/recent-rooms-controller";
import { SessionController } from "@src/controllers/session-controller";
import type { UiElements } from "@src/views/dom";
import { bindAllDomEvents, type DomEventsContext } from "@src/views/dom-events";
import type { TileView } from "@src/views/tile-view";

function makeFakeElement() {
  return {
    value: "",
    disabled: false,
    addEventListener: vi.fn(),
    focus: vi.fn(),
    blur: vi.fn(),
  };
}

describe("bindAllDomEvents", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("succeeds on boot and leaves name inputs empty when localStorage.getItem throws SecurityError", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });
    vi.stubGlobal("document", {
      hidden: false,
      addEventListener: vi.fn(),
    });
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
    });

    const session = new SessionController({
      getLocalStorage: () => null,
      getSessionStorage: () => null,
      getLocks: () => null,
      runBackground: vi.fn(),
      onForgetHostUiChange: vi.fn(),
    });
    const recentRooms = new RecentRoomsController({
      getLocalStorage: () => null,
      getLocks: () => null,
      runBackground: vi.fn(),
      hasSavedCreatorHostFor: () => false,
      onRemoveHostToken: vi.fn(),
      onForgetAllHostTokens: vi.fn(),
      onChange: vi.fn(),
    });

    const nameInput = makeFakeElement();
    const roomNameInput = makeFakeElement();
    const ui = {
      inviteBtn: makeFakeElement(),
      inviteShowBtn: makeFakeElement(),
      inviteCopyLinkBtn: makeFakeElement(),
      inviteCopyCodeBtn: makeFakeElement(),
      inviteForgetHostBtn: makeFakeElement(),
      inviteRotateBtn: makeFakeElement(),
      rosterBtn: makeFakeElement(),
      lockBtn: makeFakeElement(),
      brandHomeBtn: makeFakeElement(),
      nameInput,
      roomNameInput,
      roomInput: makeFakeElement(),
      joinBtn: makeFakeElement(),
      createBtn: makeFakeElement(),
      shareBtn: makeFakeElement(),
    } as unknown as UiElements;

    const ctx: DomEventsContext = {
      controllers: {
        session,
        recentRooms,
        invite: new InviteController({ onChange: vi.fn() }),
        popovers: new PopoverToastController({ onJoinChipChange: vi.fn() }),
      },
      views: {
        ui,
        tileView: { renderAllControls: vi.fn() } as unknown as TileView,
      },
      state: {
        getClient: () => null,
        isSharing: () => false,
        isFocusedAndVisible: () => true,
        currentName: () => "guest",
      },
      actions: {
        runBackground: vi.fn(),
        setStatus: vi.fn(),
        setLobbyError: vi.fn(),
        setLobbyNotice: vi.fn(),
        showTransientRoomNotice: vi.fn(),
        dismissTransientRoomNotice: vi.fn(),
        togglePopover: vi.fn(),
        closeAllPopovers: vi.fn(),
        renderInviteMenu: vi.fn(),
        renderJoinChip: vi.fn(),
        renderRoster: vi.fn(),
        scrubRoomUrl: vi.fn(),
        startSharing: vi.fn().mockResolvedValue(undefined),
        stopSharing: vi.fn().mockResolvedValue(undefined),
        enterInvite: vi.fn().mockResolvedValue(undefined),
        joinRoom: vi.fn().mockResolvedValue(undefined),
        leaveRoom: vi.fn(),
        syncNameInputs: vi.fn(),
        joinFromBootOrHash: vi.fn(),
      },
    };

    expect(() => bindAllDomEvents(ctx)).not.toThrow();
    expect(nameInput.value).toBe("");
    expect(roomNameInput.value).toBe("");
  });
});
