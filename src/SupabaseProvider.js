import * as Y from "yjs";
import { supabase } from "./supabaseClient";

export class SupabaseProvider {
  constructor(doc, roomId, localUser) {
    this.doc = doc;
    this.roomId = roomId;
    this.localUser = localUser;
    this._onUpdate = this._onUpdate.bind(this);
    this._saveTimer = null;
    this.presenceCallback = null;
    this.statusCallback = null;
    this.destroyed = false;

    this.channel = supabase.channel(roomId, {
      config: {
        broadcast: { self: false, ack: false },
        presence: { key: localUser.id },
      },
    });

    // Receive Y.js updates — apply with "remote" origin so _onUpdate skips re-broadcast
    this.channel.on("broadcast", { event: "y-update" }, ({ payload }) => {
      if (this.destroyed) return;
      try {
        const update = Uint8Array.from(Object.values(payload.update));
        Y.applyUpdate(doc, update, "remote");
      } catch {
        // malformed update — ignore, CRDT state is unaffected
      }
    });

    // A newly joined peer requests full state so it can catch up
    this.channel.on("broadcast", { event: "y-request-state" }, ({ payload }) => {
      if (this.destroyed) return;
      const fullState = Y.encodeStateAsUpdate(doc);
      this.channel.send({
        type: "broadcast",
        event: "y-full-state",
        payload: { update: Array.from(fullState), for: payload.from },
      });
    });

    // Receive a full-state catch-up response
    this.channel.on("broadcast", { event: "y-full-state" }, ({ payload }) => {
      if (this.destroyed) return;
      if (payload.for && payload.for !== localUser.id) return;
      try {
        const update = Uint8Array.from(Object.values(payload.update));
        Y.applyUpdate(doc, update, "remote");
      } catch { /* ignore */ }
    });

    // Presence
    this.channel.on("presence", { event: "sync" }, () => {
      if (!this.destroyed) this.presenceCallback?.(this._presencePeers());
    });
    this.channel.on("presence", { event: "join" }, () => {
      if (!this.destroyed) this.presenceCallback?.(this._presencePeers());
    });
    this.channel.on("presence", { event: "leave" }, () => {
      if (!this.destroyed) this.presenceCallback?.(this._presencePeers());
    });

    this.channel.subscribe(async (status) => {
      if (this.destroyed) return;

      if (status === "SUBSCRIBED") {
        // Track own presence
        await this.channel.track({ ...localUser, cursor: 0, variantId: null });

        // Ask peers for their full state so we don't miss history
        this.channel.send({
          type: "broadcast",
          event: "y-request-state",
          payload: { from: localUser.id },
        });

        this.statusCallback?.("connected");
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        this.statusCallback?.("error — reconnecting");
      } else if (status === "CLOSED") {
        this.statusCallback?.("disconnected");
      }
    });

    doc.on("update", this._onUpdate);
  }

  _onUpdate(update, origin) {
    if (this.destroyed) return;
    if (origin === "remote") return;

    this.channel.send({
      type: "broadcast",
      event: "y-update",
      payload: { update: Array.from(update) },
    });

    // Debounced DB snapshot for reload persistence
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      const snapshot = Array.from(Y.encodeStateAsUpdate(this.doc));
      supabase
        .from("document_snapshots")
        .upsert({ room_id: this.roomId, snapshot, updated_at: new Date().toISOString() })
        .then(({ error }) => {
          if (error) console.warn("[SupabaseProvider] snapshot save failed:", error.message);
        });
    }, 2000);
  }

  sendCursor(offset, variantId) {
    if (this.destroyed) return;
    this.channel.track({ ...this.localUser, cursor: offset, variantId });
  }

  _presencePeers() {
    const state = this.channel.presenceState();
    return Object.values(state)
      .flat()
      .filter((p) => p.id !== this.localUser.id);
  }

  onPresence(callback) { this.presenceCallback = callback; }
  onStatus(callback)   { this.statusCallback = callback; }

  destroy() {
    this.destroyed = true;
    clearTimeout(this._saveTimer);
    this.doc.off("update", this._onUpdate);
    supabase.removeChannel(this.channel);
  }
}

/** Load a persisted snapshot from Supabase so new sessions inherit full history. */
export async function loadSnapshot(doc, roomId) {
  const { data, error } = await supabase
    .from("document_snapshots")
    .select("snapshot")
    .eq("room_id", roomId)
    .maybeSingle();

  if (error) {
    console.warn("[SupabaseProvider] loadSnapshot error:", error.message);
    return;
  }
  if (data?.snapshot) {
    Y.applyUpdate(doc, new Uint8Array(data.snapshot), "remote");
  }
}
