import { defineStore } from "pinia";
import { api, errorMessage, patch, post } from "../lib/api";
import type {
  MailMessage,
  MessageDetail,
  MessagePage,
  Settings,
} from "../../shared/types";

type MessageChanges = {
  isStarred?: boolean;
  isArchived?: boolean;
  isDeleted?: boolean;
  isRead?: boolean;
};

export const useMailStore = defineStore("mail", {
  state: () => ({
    messages: [] as MailMessage[],
    selected: null as MessageDetail | null,
    folder: "inbox",
    loading: false,
    opening: false,
    query: "",
    mailboxFilter: "",
    domainFilter: "",
    unreadOnly: false,
    offset: 0,
    limit: 50,
    total: 0,
    requestId: 0,
    openRequestId: 0,
    detailRequestId: 0,
    detailStale: false,
    statsRequestId: 0,
    error: "",
    updating: false,
    sessionGeneration: 0,
    undoAction: null as {
      message: MailMessage;
      changes: MessageChanges;
      label: "archived" | "unarchived" | "trashed" | "restored";
    } | null,
    stats: { domains: 0, mailboxes: 0, messages: 0, unread: 0 },
    resendConfigured: false,
    webhookConfigured: false,
    failures: [] as Settings["failures"],
  }),
  actions: {
    async load(reset = false): Promise<void> {
      if (reset) this.offset = 0;
      const requestId = ++this.requestId;
      this.loading = true;
      this.error = "";
      try {
        const params = new URLSearchParams({
          folder: this.folder,
          limit: String(this.limit),
          offset: String(this.offset),
        });
        if (this.query) params.set("q", this.query);
        if (this.mailboxFilter) params.set("mailbox", this.mailboxFilter);
        if (this.domainFilter) params.set("domain", this.domainFilter);
        if (this.unreadOnly) params.set("unread", "1");
        const page = await api<MessagePage>(`/messages?${params}`);
        if (requestId !== this.requestId) return;
        if (
          !page.items.length &&
          this.offset > 0 &&
          this.offset >= page.total
        ) {
          this.offset = Math.max(
            0,
            Math.floor((page.total - 1) / this.limit) * this.limit,
          );
          return this.load();
        }
        this.messages = page.items;
        this.total = page.total;
        if (this.selected) {
          const latest = page.items.find((m) => m.id === this.selected?.id);
          if (!latest) this.clearSelection();
          else {
            const deliveryChanged =
              latest.status !== this.selected.status ||
              (latest.delivery_revision !== undefined &&
                latest.delivery_revision !== this.selected.delivery_revision) ||
              (latest.send_error !== undefined &&
                latest.send_error !== this.selected.send_error);
            Object.assign(this.selected, latest);
            if (
              latest.direction === "outbound" &&
              (deliveryChanged || this.detailStale)
            )
              await this.refreshSelected(latest.id);
          }
        }
      } catch (error) {
        if (requestId === this.requestId) this.error = errorMessage(error);
      } finally {
        if (requestId === this.requestId) this.loading = false;
      }
    },
    clearSelection() {
      this.openRequestId++;
      this.detailRequestId++;
      this.detailStale = false;
      this.selected = null;
      this.opening = false;
    },
    async open(id: string) {
      const requestId = ++this.openRequestId;
      const generation = this.sessionGeneration;
      this.detailRequestId++;
      if (this.selected?.id !== id) this.selected = null;
      this.opening = true;
      this.error = "";
      try {
        const message = await api<MessageDetail>(`/messages/${id}`);
        if (
          requestId !== this.openRequestId ||
          generation !== this.sessionGeneration
        )
          return;
        // Reading the body does not depend on the secondary read receipt or
        // unread-count refresh succeeding.
        this.selected = message;
        this.detailStale = false;
        this.opening = false;
        if (!message.is_read) {
          await patch(`/messages/${id}`, { isRead: true });
          if (generation !== this.sessionGeneration) return;
          if (this.selected?.id === id) this.selected.is_read = 1;
          const row = this.messages.find((m) => m.id === id);
          if (row) row.is_read = 1;
          await this.loadStats();
        }
      } catch (error) {
        if (requestId === this.openRequestId) this.error = errorMessage(error);
      } finally {
        if (requestId === this.openRequestId) this.opening = false;
      }
    },
    async refreshSelected(id: string) {
      const requestId = ++this.detailRequestId;
      this.detailStale = true;
      const selectionId = this.openRequestId;
      const generation = this.sessionGeneration;
      const isCurrent = () =>
        requestId === this.detailRequestId &&
        selectionId === this.openRequestId &&
        generation === this.sessionGeneration &&
        this.selected?.id === id;
      try {
        const detail = await api<MessageDetail>(`/messages/${id}`);
        if (!isCurrent()) return;
        if (
          (detail.delivery_revision || 0) <
          (this.selected!.delivery_revision || 0)
        )
          return;
        const latest = this.messages.find((message) => message.id === id);
        if (
          latest &&
          (detail.delivery_revision || 0) > (latest.delivery_revision || 0)
        ) {
          latest.status = detail.status;
          latest.delivery_revision = detail.delivery_revision;
          latest.send_error = detail.send_error;
        }
        // Keep flags from a more recent list/mutation while refreshing the
        // recipient outcomes and retry details of the currently open message.
        Object.assign(this.selected!, detail, latest);
        this.detailStale = false;
      } catch (error) {
        if (isCurrent()) this.error = errorMessage(error);
      }
    },
    async update(
      message: MailMessage,
      changes: MessageChanges,
      remember = true,
    ) {
      if (this.updating) return;
      this.updating = true;
      const snapshot = { ...message };
      const generation = this.sessionGeneration;
      try {
        await patch(`/messages/${message.id}`, changes);
        // A completed request must not repopulate a signed-out workspace.
        if (generation !== this.sessionGeneration) return;
        if (
          remember &&
          (changes.isArchived !== undefined || changes.isDeleted !== undefined)
        ) {
          this.undoAction = {
            message: snapshot,
            changes:
              changes.isDeleted !== undefined
                ? { isDeleted: !!snapshot.is_deleted }
                : { isArchived: !!snapshot.is_archived },
            label:
              changes.isDeleted !== undefined
                ? changes.isDeleted
                  ? "trashed"
                  : "restored"
                : changes.isArchived
                  ? "archived"
                  : "unarchived",
          };
        } else if (!remember) this.undoAction = null;
        if (this.selected?.id === message.id) {
          if (changes.isStarred !== undefined)
            this.selected.is_starred = Number(changes.isStarred);
          if (changes.isArchived !== undefined)
            this.selected.is_archived = Number(changes.isArchived);
          if (changes.isDeleted !== undefined)
            this.selected.is_deleted = Number(changes.isDeleted);
          if (changes.isRead !== undefined)
            this.selected.is_read = Number(changes.isRead);
        }
        await Promise.all([this.load(), this.loadStats()]);
      } catch (error) {
        if (generation === this.sessionGeneration)
          this.error = errorMessage(error);
      } finally {
        if (generation === this.sessionGeneration) this.updating = false;
      }
    },
    async undo() {
      const action = this.undoAction;
      if (action) await this.update(action.message, action.changes, false);
    },
    toggleStar(message: MailMessage) {
      return this.update(message, { isStarred: !message.is_starred });
    },
    archive(message: MailMessage) {
      return this.update(message, { isArchived: !message.is_archived });
    },
    trash(message: MailMessage) {
      return this.update(message, { isDeleted: !message.is_deleted });
    },
    async retry(message: MailMessage) {
      const generation = this.sessionGeneration;
      const selectionId = this.openRequestId;
      try {
        await post(`/send/${message.id}/retry`, {});
        if (generation !== this.sessionGeneration) return;
        await this.load();
        if (
          generation === this.sessionGeneration &&
          selectionId === this.openRequestId &&
          this.selected?.id === message.id
        )
          await this.open(message.id);
      } catch (error) {
        if (generation !== this.sessionGeneration) return;
        const reason = errorMessage(error);
        await this.load();
        if (generation === this.sessionGeneration) this.error = reason;
      }
    },
    async loadStats() {
      const requestId = ++this.statsRequestId;
      const settings = await api<Settings>("/settings");
      if (requestId !== this.statsRequestId) return;
      this.stats = settings.stats;
      this.resendConfigured = settings.resendConfigured;
      this.webhookConfigured = settings.webhookConfigured;
      this.failures = settings.failures;
    },
    reset() {
      this.sessionGeneration++;
      this.updating = false;
      this.requestId++;
      this.statsRequestId++;
      this.clearSelection();
      this.messages = [];
      this.error = "";
      this.total = 0;
      this.offset = 0;
      this.folder = "inbox";
      this.query = "";
      this.mailboxFilter = "";
      this.domainFilter = "";
      this.unreadOnly = false;
      this.loading = false;
      this.stats = { domains: 0, mailboxes: 0, messages: 0, unread: 0 };
      this.failures = [];
      this.resendConfigured = false;
      this.webhookConfigured = false;
      this.undoAction = null;
    },
  },
});
