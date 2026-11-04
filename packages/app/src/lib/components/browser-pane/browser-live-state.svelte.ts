import type { LiveMessage, LiveSource } from "$lib/api/browser-live";
import { applyMessage, type LiveView } from "./live-view";

/**
 * A viewer of one run's browser: the stream's state, held field by field so a frame arriving ten
 * times a second wakes the viewport and nothing else. The rules for how each message moves it are
 * `applyMessage`'s; this only holds the result.
 *
 * Nothing is fetched until `connect` is called, and `connect` hands back the way to stop: the pane
 * calls it from an effect, so the stream is open exactly while the pane is.
 */
export class BrowserLiveState {
  room = $state(false);
  done = $state(false);
  dropped = $state(0);
  uplink = $state(false);
  status = $state<LiveView["status"]>("idle");
  tabs = $state.raw<LiveView["tabs"]>([]);
  frame = $state.raw<LiveView["frame"]>(null);
  console = $state.raw<LiveView["console"]>([]);
  network = $state.raw<LiveView["network"]>([]);
  actions = $state.raw<LiveView["actions"]>([]);
  highlight = $state.raw<LiveView["highlight"]>(null);
  /** Whether the stream is up, as far as this viewer can tell. */
  connection = $state<"connecting" | "open" | "retrying">("connecting");
  #nextId = 1;
  readonly #source: LiveSource;

  constructor(source: LiveSource) {
    this.#source = source;
  }

  connect(): () => void {
    this.connection = "connecting";
    return this.#source({
      onMessage: (message) => this.apply(message),
      onOpen: () => (this.connection = "open"),
      onRetry: () => {
        if (!this.done) this.connection = "retrying";
      },
    });
  }

  /** One message, folded in. Public so a fixture can drive the state without a source. */
  apply(message: LiveMessage): void {
    if (message.kind === "room") this.connection = "open";
    const patch = applyMessage(this.#view(), message);
    if (patch.room !== undefined) this.room = patch.room;
    if (patch.done !== undefined) this.done = patch.done;
    if (patch.dropped !== undefined) this.dropped = patch.dropped;
    if (patch.uplink !== undefined) this.uplink = patch.uplink;
    if (patch.status !== undefined) this.status = patch.status;
    if (patch.tabs !== undefined) this.tabs = patch.tabs;
    if (patch.frame !== undefined) this.frame = patch.frame;
    if (patch.console !== undefined) this.console = patch.console;
    if (patch.network !== undefined) this.network = patch.network;
    if (patch.actions !== undefined) this.actions = patch.actions;
    if (patch.highlight !== undefined) this.highlight = patch.highlight;
    if (patch.nextId !== undefined) this.#nextId = patch.nextId;
  }

  #view(): LiveView {
    return {
      room: this.room,
      done: this.done,
      dropped: this.dropped,
      uplink: this.uplink,
      status: this.status,
      tabs: this.tabs,
      frame: this.frame,
      console: this.console,
      network: this.network,
      actions: this.actions,
      highlight: this.highlight,
      nextId: this.#nextId,
    };
  }
}
