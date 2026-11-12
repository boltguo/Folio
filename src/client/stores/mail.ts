import { defineStore } from "pinia";
import { api, errorMessage, patch, post } from "../lib/api";
import type {
  MailMessage,
  MessageDetail,
  MessagePage,
  Settings,
} from "../../shared/types";

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
    statsRequestId: 0,
    error: "",
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
        if (
          this.selected &&
          !page.items.some((m) => m.id === this.selected?.id)
        )
          this.clearSelection();
      } catch (error) {
        if (requestId === this.requestId) this.error = errorMessage(error);
      } finally {
        if (requestId === this.requestId) this.loading = false;
      }
    },
    clearSelection() {
      this.openRequestId++;
      this.selected = null;
      this.opening = false;
    },
    async open(id: string) {
      const requestId = ++this.openRequestId;
      this.opening = true;
      this.error = "";
      try {
        const message = await api<MessageDetail>(`/messages/${id}`);
        if (requestId !== this.openRequestId) return;
        if (!message.is_read) {
          await patch(`/messages/${id}`, { isRead: true });
          message.is_read = 1;
          const row = this.messages.find((m) => m.id === id);
          if (row) row.is_read = 1;
          await this.loadStats();
        }
        if (requestId === this.openRequestId) this.selected = message;
      } catch (error) {
        if (requestId === this.openRequestId) this.error = errorMessage(error);
      } finally {
        if (requestId === this.openRequestId) this.opening = false;
      }
    },
    async update(
      message: MailMessage,
      changes: {
        isStarred?: boolean;
        isArchived?: boolean;
        isDeleted?: boolean;
        isRead?: boolean;
      },
    ) {
      try {
        await patch(`/messages/${message.id}`, changes);
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
        this.error = errorMessage(error);
      }
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
      try {
        await post(`/send/${message.id}/retry`, {});
        await this.load();
        await this.open(message.id);
      } catch (error) {
        const reason = errorMessage(error);
        await this.load();
        this.error = reason;
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
    },
  },
});
