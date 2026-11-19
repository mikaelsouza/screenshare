function el<T extends HTMLElement>(id: string): T {
  const selector = typeof CSS !== "undefined" && typeof CSS.escape === "function" ? `#${CSS.escape(id)}` : `#${id}`;
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`missing element #${id}`);
  return node;
}

export interface UiElements {
  lobby: HTMLElement;
  nameInput: HTMLInputElement;
  roomNameInput: HTMLInputElement;
  roomInput: HTMLInputElement;
  lobbyError: HTMLElement;
  lobbyForgetHostsBtn: HTMLButtonElement;
  joinBtn: HTMLButtonElement;
  createBtn: HTMLButtonElement;
  brandHomeBtn: HTMLButtonElement;
  roomBar: HTMLElement;
  inviteBtn: HTMLButtonElement;
  inviteMenu: HTMLElement;
  inviteRotateBtn: HTMLButtonElement;
  inviteLockedNote: HTMLElement;
  inviteCopyLinkBtn: HTMLButtonElement;
  inviteLinkFeedback: HTMLElement;
  inviteCodeRow: HTMLElement;
  inviteCodeValue: HTMLElement;
  inviteShowBtn: HTMLButtonElement;
  inviteCopyCodeBtn: HTMLButtonElement;
  inviteForgetHostBtn: HTMLButtonElement;
  rosterBtn: HTMLButtonElement;
  rosterUnreadDot: HTMLElement;
  rosterBtnLabel: HTMLElement;
  roster: HTMLElement;
  rosterTitle: HTMLElement;
  rosterList: HTMLUListElement;
  lockBtn: HTMLButtonElement;
  followChip: HTMLElement;
  followDot: HTMLElement;
  followChipText: HTMLElement;
  status: HTMLElement;
  stage: HTMLDivElement;
  joinChip: HTMLElement;
  stageEmpty: HTMLElement;
  stageEmptyTitle: HTMLElement;
  stageEmptySub: HTMLElement;
  controls: HTMLElement;
  liveControls: HTMLElement;
  presetBtn: HTMLButtonElement;
  presetBtnLabel: HTMLElement;
  presetMenu: HTMLElement;
  presetList: HTMLElement;
  codecBtn: HTMLButtonElement;
  codecBtnLabel: HTMLElement;
  codecMenu: HTMLElement;
  codecList: HTMLElement;
  degradationBtn: HTMLButtonElement;
  degradationBtnLabel: HTMLElement;
  degradationMenu: HTMLElement;
  degradationList: HTMLElement;
  togglePreviewBtn: HTMLButtonElement;
  muteAudioBtn: HTMLButtonElement;
  shareBtn: HTMLButtonElement;
}

export function queryUiElements(): UiElements {
  return {
    lobby: el<HTMLElement>("lobby"),
    nameInput: el<HTMLInputElement>("display-name"),
    roomNameInput: el<HTMLInputElement>("room-name"),
    roomInput: el<HTMLInputElement>("room-code"),
    lobbyError: el<HTMLElement>("lobby-error"),
    lobbyForgetHostsBtn: el<HTMLButtonElement>("lobby-forget-hosts"),
    joinBtn: el<HTMLButtonElement>("join"),
    createBtn: el<HTMLButtonElement>("create"),
    brandHomeBtn: el<HTMLButtonElement>("brand-home"),
    roomBar: el<HTMLElement>("room-bar"),
    inviteBtn: el<HTMLButtonElement>("invite-btn"),
    inviteMenu: el<HTMLElement>("invite-menu"),
    inviteRotateBtn: el<HTMLButtonElement>("invite-rotate-btn"),
    inviteLockedNote: el<HTMLElement>("invite-locked-note"),
    inviteCopyLinkBtn: el<HTMLButtonElement>("invite-copy-link"),
    inviteLinkFeedback: el<HTMLElement>("invite-link-feedback"),
    inviteCodeRow: el<HTMLElement>("invite-code-row"),
    inviteCodeValue: el<HTMLElement>("invite-code-value"),
    inviteShowBtn: el<HTMLButtonElement>("invite-show-btn"),
    inviteCopyCodeBtn: el<HTMLButtonElement>("invite-copy-code"),
    inviteForgetHostBtn: el<HTMLButtonElement>("invite-forget-host"),
    rosterBtn: el<HTMLButtonElement>("roster-btn"),
    rosterUnreadDot: el<HTMLElement>("roster-unread-dot"),
    rosterBtnLabel: el<HTMLElement>("roster-btn-label"),
    roster: el<HTMLElement>("roster"),
    rosterTitle: el<HTMLElement>("roster-title"),
    rosterList: el<HTMLUListElement>("roster-list"),
    lockBtn: el<HTMLButtonElement>("lock-btn"),
    followChip: el<HTMLElement>("follow-chip"),
    followDot: el<HTMLElement>("follow-dot"),
    followChipText: el<HTMLElement>("follow-chip-text"),
    status: el<HTMLElement>("status"),
    stage: el<HTMLDivElement>("stage"),
    joinChip: el<HTMLElement>("join-chip"),
    stageEmpty: el<HTMLElement>("stage-empty"),
    stageEmptyTitle: el<HTMLElement>("stage-empty-title"),
    stageEmptySub: el<HTMLElement>("stage-empty-sub"),
    controls: el<HTMLElement>("controls"),
    liveControls: el<HTMLElement>("live-controls"),
    presetBtn: el<HTMLButtonElement>("preset-btn"),
    presetBtnLabel: el<HTMLElement>("preset-btn-label"),
    presetMenu: el<HTMLElement>("preset-menu"),
    presetList: el<HTMLElement>("preset-list"),
    codecBtn: el<HTMLButtonElement>("codec-btn"),
    codecBtnLabel: el<HTMLElement>("codec-btn-label"),
    codecMenu: el<HTMLElement>("codec-menu"),
    codecList: el<HTMLElement>("codec-list"),
    degradationBtn: el<HTMLButtonElement>("degradation-btn"),
    degradationBtnLabel: el<HTMLElement>("degradation-btn-label"),
    degradationMenu: el<HTMLElement>("degradation-menu"),
    degradationList: el<HTMLElement>("degradation-list"),
    togglePreviewBtn: el<HTMLButtonElement>("toggle-preview"),
    muteAudioBtn: el<HTMLButtonElement>("mute-audio"),
    shareBtn: el<HTMLButtonElement>("share"),
  };
}

export function setStatusDom(ui: UiElements, text: string, kind: "info" | "warn" | "error" = "info"): void {
  ui.status.textContent = text;
  ui.status.dataset["kind"] = kind;
  ui.status.hidden = kind === "info" || text.length === 0;
}

export function setLobbyErrorDom(ui: UiElements, message: string | null): void {
  ui.lobbyError.textContent = message ?? "";
  ui.lobbyError.hidden = message === null || message.length === 0;
  ui.roomInput.classList.toggle("input-error", message !== null && message.length > 0);
}

export function scrubRoomUrlDom(): void {
  if (location.hash.length > 0) history.replaceState(null, "", location.pathname + location.search);
}

export function currentNameDom(ui: UiElements): string {
  const typed = ui.nameInput.value.trim().slice(0, 32);
  if (typed) return typed;
  let stored = localStorage.getItem("name");
  if (!stored) {
    stored = `guest-${Math.random().toString(36).slice(2, 6)}`;
    localStorage.setItem("name", stored);
  }
  return stored;
}

export function syncNameInputsDom(ui: UiElements, value: string): string {
  const clean = value.trim().slice(0, 32);
  ui.nameInput.value = clean;
  ui.roomNameInput.value = clean;
  if (clean) localStorage.setItem("name", clean);
  return clean;
}

