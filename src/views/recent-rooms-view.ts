import {
  MAX_RECENT_ROOM_LABEL_LEN,
  MAX_RECENT_ROOM_PEERS,
  formatRelativeTime,
  type RecentRoomEntry,
} from "../recent-rooms";
import "./recent-rooms.css";

export interface RecentRoomsViewCallbacks {
  onRejoin: (code: string) => void;
  onStartRename: (code: string) => void;
  onCommitRename: (code: string, label: string) => void;
  onCancelRename: () => void;
  onRemove: (code: string) => void;
  onClearAll: () => void;
  onSetDisabled: (disabled: boolean) => void;
  onSearchChange: (query: string) => void;
}

export interface RecentRoomsRenderState {
  disabled: boolean;
  totalCount: number;
  filteredRooms: readonly RecentRoomEntry[];
  searchQuery: string;
  editingCode: string | null;
}

type ViewMode = "hidden" | "disabled" | "few" | "many";

interface RenameDraft {
  code: string;
  value: string;
  focused: boolean;
  selectionStart: number | null;
  selectionEnd: number | null;
  detachedInput: HTMLInputElement;
}

function isFocusedByOtherElement(detachedInput: HTMLInputElement): boolean {
  if (typeof document === "undefined") return false;
  const activeEl = document.activeElement;
  return activeEl !== null && activeEl !== detachedInput && activeEl !== document.body;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function buildRenameRow(
  room: RecentRoomEntry,
  callbacks: RecentRoomsViewCallbacks,
): { wrap: HTMLDivElement; input: HTMLInputElement } {
  const wrap = el("div", "recent-room-rename");
  const input = el("input", "ui-input recent-room-rename-input");
  input.type = "text";
  input.maxLength = MAX_RECENT_ROOM_LABEL_LEN;
  input.placeholder = `Nickname for ${room.code}`;
  input.spellcheck = false;
  input.setAttribute("aria-label", `Nickname for ${room.code}`);
  input.value = room.label ?? "";

  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      callbacks.onCommitRename(room.code, input.value);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      callbacks.onCancelRename();
    }
  });

  const saveBtn = el("button", "ui-btn primary recent-btn-xs", "Save");
  saveBtn.type = "button";
  saveBtn.addEventListener("click", () => callbacks.onCommitRename(room.code, input.value));

  const cancelBtn = el("button", "ui-btn recent-btn-xs", "Cancel");
  cancelBtn.type = "button";
  cancelBtn.addEventListener("click", () => callbacks.onCancelRename());

  wrap.append(input, saveBtn, cancelBtn);
  return { wrap, input };
}

function buildRoomSubtitle(room: RecentRoomEntry): string {
  const parts: string[] = [];
  if (room.label) parts.push(room.code);
  if (room.peerNames.length > 0) {
    parts.push(`with ${room.peerNames.slice(0, MAX_RECENT_ROOM_PEERS).join(", ")}`);
  }
  parts.push(formatRelativeTime(room.lastJoinedAt));
  return parts.join(" \u00b7 ");
}

function buildRoomRow(
  room: RecentRoomEntry,
  editingCode: string | null,
  callbacks: RecentRoomsViewCallbacks,
): { row: HTMLDivElement; renameInput: HTMLInputElement | null } {
  const row = el("div", "recent-room-row");
  row.dataset["roomCode"] = room.code;

  if (editingCode === room.code) {
    const { wrap, input } = buildRenameRow(room, callbacks);
    row.append(wrap);
    return { row, renameInput: input };
  }

  const rejoinBtn = el("button", "recent-room-rejoin");
  rejoinBtn.type = "button";
  rejoinBtn.addEventListener("click", () => callbacks.onRejoin(room.code));

  const top = el("div", "recent-room-top");
  const titleText = room.label ?? room.code;
  const title = el("span", room.label ? "recent-room-title" : "recent-room-title recent-room-mono", titleText);
  const badge = el(
    "span",
    `recent-room-badge ${room.role}`,
    room.role === "host" ? "Host" : "Guest",
  );
  top.append(title, badge);

  const sub = el("div", "recent-room-sub", buildRoomSubtitle(room));
  rejoinBtn.append(top, sub);

  const actions = el("div", "recent-room-actions");
  const editBtn = el("button", "recent-icon-btn recent-room-edit-btn", "\u270e");
  editBtn.type = "button";
  editBtn.title = "Rename locally";
  editBtn.setAttribute("aria-label", `Rename ${room.code} locally`);
  editBtn.addEventListener("click", () => callbacks.onStartRename(room.code));

  const removeBtn = el("button", "recent-icon-btn recent-room-delete-btn", "\u00d7");
  removeBtn.type = "button";
  removeBtn.title = "Remove from saved rooms";
  removeBtn.setAttribute("aria-label", `Remove ${room.code} from saved rooms`);
  removeBtn.addEventListener("click", () => callbacks.onRemove(room.code));

  actions.append(editBtn, removeBtn);
  row.append(rejoinBtn, actions);
  return { row, renameInput: null };
}

function buildPrivacyFooter(
  disabled: boolean,
  totalCount: number,
  callbacks: RecentRoomsViewCallbacks,
): { footer: HTMLDivElement; clearBtn: HTMLButtonElement; checkbox: HTMLInputElement } {
  const footer = el("div", "recent-rooms-footer");
  const label = el("label", "recent-rooms-optout");
  const checkbox = el("input");
  checkbox.id = "recent-rooms-optout";
  checkbox.type = "checkbox";
  checkbox.checked = disabled;
  checkbox.addEventListener("change", () => callbacks.onSetDisabled(checkbox.checked));
  label.append(checkbox, el("span", undefined, "Don't save rooms on this device"));

  const clearBtn = el("button", "ui-btn danger recent-btn-xs", "Clear saved rooms");
  clearBtn.id = "recent-rooms-clear";
  clearBtn.type = "button";
  clearBtn.disabled = totalCount === 0;
  clearBtn.title = "Remove all saved recent rooms and host tokens from this device";
  clearBtn.addEventListener("click", () => callbacks.onClearAll());

  footer.append(label, clearBtn);
  return { footer, clearBtn, checkbox };
}

/**
 * Adaptive progressive-disclosure Recent Rooms view inside `.lobby-card` (Mock #12).
 * Built exclusively with createElement/textContent/replaceChildren for strict CSP & Trusted Types.
 */
export class RecentRoomsView {
  private readonly lobbyCard: HTMLElement;
  private readonly root: HTMLElement;
  private readonly callbacks: RecentRoomsViewCallbacks;
  private mode: ViewMode = "hidden";
  private dividerEl: HTMLDivElement | null = null;
  private searchInput: HTMLInputElement | null = null;
  private listEl: HTMLDivElement | null = null;
  private clearBtn: HTMLButtonElement | null = null;
  private optOutCheckbox: HTMLInputElement | null = null;
  private lastFocusedEditCode: string | null = null;
  private activeRename: { code: string; input: HTMLInputElement } | null = null;
  private hiddenRenameDraft: RenameDraft | null = null;

  constructor(lobbyCard: HTMLElement, root: HTMLElement, callbacks: RecentRoomsViewCallbacks) {
    this.lobbyCard = lobbyCard;
    this.root = root;
    this.callbacks = callbacks;
  }

  private resolveMode(state: RecentRoomsRenderState): ViewMode {
    if (state.disabled) return "disabled";
    if (state.totalCount === 0) return "hidden";
    return state.totalCount <= 2 ? "few" : "many";
  }

  private resetRefs(): void {
    this.dividerEl = null;
    this.searchInput = null;
    this.listEl = null;
    this.clearBtn = null;
    this.optOutCheckbox = null;
  }

  private renderDisabled(): void {
    this.resetRefs();
    const banner = el("div", "recent-rooms-disabled");
    banner.append(el("span", undefined, "Room saving is off for this shared device."));
    const enableBtn = el("button", "ui-btn recent-btn-sm", "Enable");
    enableBtn.id = "recent-rooms-enable";
    enableBtn.type = "button";
    enableBtn.addEventListener("click", () => this.callbacks.onSetDisabled(false));
    banner.append(enableBtn);
    this.root.replaceChildren(banner);
    this.root.hidden = false;
  }

  private buildContainer(mode: "few" | "many"): void {
    const divider = el("div", "lobby-divider");
    const list = el("div", mode === "many" ? "recent-rooms-list is-scrollable" : "recent-rooms-list");
    const { footer, clearBtn, checkbox } = buildPrivacyFooter(false, 1, this.callbacks);

    this.dividerEl = divider;
    this.listEl = list;
    this.clearBtn = clearBtn;
    this.optOutCheckbox = checkbox;

    if (mode === "many") {
      const search = el("input", "ui-input recent-rooms-search");
      search.id = "recent-rooms-search";
      search.type = "text";
      search.placeholder = "Filter saved rooms...";
      search.autocomplete = "off";
      search.spellcheck = false;
      search.setAttribute("aria-label", "Filter saved rooms");
      search.addEventListener("input", () => this.callbacks.onSearchChange(search.value));
      this.searchInput = search;
      this.root.replaceChildren(divider, search, list, footer);
    } else {
      this.searchInput = null;
      this.root.replaceChildren(divider, list, footer);
    }
    this.root.hidden = false;
  }

  private renderList(state: RecentRoomsRenderState): HTMLInputElement | null {
    if (!this.listEl) return null;
    if (state.filteredRooms.length === 0) {
      this.listEl.replaceChildren(el("p", "recent-rooms-empty-filter", "No matching rooms."));
      return null;
    }
    let renameInputToFocus: HTMLInputElement | null = null;
    const rows: HTMLDivElement[] = [];
    for (const room of state.filteredRooms) {
      const built = buildRoomRow(room, state.editingCode, this.callbacks);
      rows.push(built.row);
      if (built.renameInput) renameInputToFocus = built.renameInput;
    }
    this.listEl.replaceChildren(...rows);
    return renameInputToFocus;
  }

  private updateHeaderAndFooter(mode: "few" | "many", state: RecentRoomsRenderState): void {
    if (this.dividerEl) {
      this.dividerEl.textContent = mode === "few" ? "quick rejoin" : `recent rooms (${state.totalCount})`;
    }
    if (this.searchInput && this.searchInput.value !== state.searchQuery) {
      this.searchInput.value = state.searchQuery;
    }
    if (this.clearBtn) {
      this.clearBtn.disabled = state.totalCount === 0;
    }
    if (this.optOutCheckbox) {
      this.optOutCheckbox.checked = state.disabled;
    }
  }

  private captureRenameDraft(nextMode: ViewMode, editingCode: string | null): RenameDraft | null {
    if ((nextMode !== "few" && nextMode !== "many") || editingCode === null) return null;
    if (this.activeRename?.code === editingCode) {
      const { input } = this.activeRename;
      return {
        code: editingCode,
        value: input.value,
        focused: typeof document !== "undefined" && document.activeElement === input,
        selectionStart: input.selectionStart ?? null,
        selectionEnd: input.selectionEnd ?? null,
        detachedInput: input,
      };
    }
    if (this.hiddenRenameDraft?.code !== editingCode) return null;
    if (this.hiddenRenameDraft.focused && isFocusedByOtherElement(this.hiddenRenameDraft.detachedInput)) {
      this.hiddenRenameDraft = { ...this.hiddenRenameDraft, focused: false };
    }
    return this.hiddenRenameDraft;
  }

  private applyRenameInputState(
    editingCode: string | null,
    input: HTMLInputElement | null,
    draft: RenameDraft | null,
  ): void {
    if (editingCode === null) {
      this.activeRename = null;
      this.hiddenRenameDraft = null;
      this.lastFocusedEditCode = null;
      return;
    }
    if (!input) {
      this.activeRename = null;
      this.hiddenRenameDraft = draft;
      if (this.lastFocusedEditCode !== editingCode) this.lastFocusedEditCode = null;
      return;
    }
    this.hiddenRenameDraft = null;
    this.activeRename = { code: editingCode, input };
    if (draft) {
      input.value = draft.value;
      if (draft.focused) input.focus();
      if (
        typeof input.setSelectionRange === "function" &&
        draft.selectionStart !== null &&
        draft.selectionEnd !== null
      ) {
        input.setSelectionRange(draft.selectionStart, draft.selectionEnd);
      }
      return;
    }
    if (editingCode !== this.lastFocusedEditCode) {
      this.lastFocusedEditCode = editingCode;
      input.focus();
      if (typeof input.select === "function") input.select();
    }
  }

  render(state: RecentRoomsRenderState): void {
    const nextMode = this.resolveMode(state);
    const renameDraft = this.captureRenameDraft(nextMode, state.editingCode);
    this.lobbyCard.classList.toggle("has-recent-rooms", !state.disabled && state.totalCount > 0);

    if (nextMode === "hidden") {
      this.mode = "hidden";
      this.lastFocusedEditCode = null;
      this.activeRename = null;
      this.hiddenRenameDraft = null;
      this.resetRefs();
      this.root.hidden = true;
      this.root.replaceChildren();
      return;
    }

    if (nextMode === "disabled") {
      this.mode = "disabled";
      this.lastFocusedEditCode = null;
      this.activeRename = null;
      this.hiddenRenameDraft = null;
      this.renderDisabled();
      return;
    }

    if (this.mode !== nextMode) {
      this.mode = nextMode;
      this.buildContainer(nextMode);
    }

    this.updateHeaderAndFooter(nextMode, state);
    const renameInputToFocus = this.renderList(state);
    this.applyRenameInputState(state.editingCode, renameInputToFocus, renameDraft);
  }
}
