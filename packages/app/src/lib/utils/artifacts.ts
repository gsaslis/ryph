// What every view of an artifact shares: where its page and its content live, the sandbox its
// frame runs in, and which version a link asks for.

/**
 * The sandbox of a frame a person looks at, exactly. Scripts run and links open in a new tab, and
 * nothing else: no `allow-same-origin` (the page would be this app's origin and could act as the
 * viewer), no top navigation, no forms, no modals.
 */
export const ARTIFACT_SANDBOX = "allow-scripts allow-popups allow-popups-to-escape-sandbox";

/** An artifact's page in the app. */
export function artifactHref(id: string, version?: number): string {
  const base = `/artifacts/${encodeURIComponent(id)}`;
  return version === undefined ? base : `${base}?v=${version}`;
}

/** The raw HTML of one version, which the frame loads. */
export function artifactContentHref(id: string, version: number): string {
  return `/artifacts/${encodeURIComponent(id)}/v/${version}/content`;
}

/**
 * The version a `?v=` asks for, when the artifact has it; otherwise the current one. A link to a
 * version that is gone, or a typo, opens the latest rather than an error.
 */
export function pickVersion(
  asked: string | null,
  versions: readonly { version: number }[],
  current: number,
): number {
  if (asked === null || !/^[1-9][0-9]*$/.test(asked)) return current;
  const n = Number(asked);
  return versions.some((v) => v.version === n) ? n : current;
}

/** A positive whole version number from a route segment, or null. */
export function parseVersion(segment: string | undefined): number | null {
  if (segment === undefined || !/^[1-9][0-9]{0,8}$/.test(segment)) return null;
  return Number(segment);
}

/** The versions a task's runs made of an artifact, as the task detail names them. */
type RunVersions = { versions: readonly { version: number; runId: string }[] };

/** The artifacts a run made a version of, in the order given. */
export function artifactsOfRun<T extends RunVersions>(
  artifacts: readonly T[],
  runId: string | null,
): T[] {
  return runId === null ? [] : artifacts.filter((a) => a.versions.some((v) => v.runId === runId));
}

/** The newest version a run made of an artifact, or null when it made none. */
export function latestRunVersion<V extends { version: number; runId: string }>(
  artifact: { versions: readonly V[] },
  runId: string | null,
): V | null {
  let latest: V | null = null;
  for (const v of artifact.versions) {
    if (v.runId === runId && (latest === null || v.version > latest.version)) latest = v;
  }
  return latest;
}

/** How a run's row names an artifact: the run made its first version, or a later one. */
export function runArtifactLabel(artifact: RunVersions, runId: string | null): string {
  return artifact.versions.some((v) => v.version === 1 && v.runId === runId)
    ? "Published artifact"
    : "Updated artifact";
}

/** What the served document posts to its parent once its own `load` has fired. */
export const ARTIFACT_LOADED = "ryph-artifact-loaded";
/** What it posts as it is being navigated away from (`pagehide`). */
export const ARTIFACT_LEAVING = "ryph-artifact-leaving";
/**
 * What the content route's 401 notice posts before anything else: the frame was refused for want
 * of a session. Only the notice's own handshake sends it, with the nonce.
 */
export const ARTIFACT_SIGN_IN = "ryph-artifact-sign-in";

/**
 * How long a placed frame may go without saying it loaded before the viewer is told it is still
 * loading. It is only a hint: a page that waits on a slow script is still the artifact, so silence
 * alone never stops it.
 */
export const STILL_LOADING_MS = 15_000;
/**
 * How long after the frame's first `load` its handshake may still arrive. The frame can live in
 * another process, so its message and the `load` the parent sees come in either order. A `load`
 * that stays unanswered past this was some other document's.
 */
export const HANDSHAKE_GRACE_MS = 3_000;

/** A fresh secret for one placement of a frame, which the frame gets as its `name`. */
export function frameNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Tells the artifact's own document from anything it navigates its frame to.
 *
 * The parent names the frame with a fresh nonce for each placement. The server puts a script first
 * in the document that takes the name, clears it, and posts it back once the document's `load`
 * fires; nothing the author wrote can read it. A document that is not the one the parent asked for
 * cannot answer, so the guard accepts exactly one `load` matched by exactly one handshake. Any
 * other `load` (a second one, or one left unanswered past the grace), a second handshake, or a
 * leaving notice is a stray.
 *
 * Silence is not a stray. App pages forbid frames from any other origin (`frame-src 'self'`), so a
 * frame sent elsewhere gets an error page whose `load` the parent sees. A frame that has not
 * loaded after `STILL_LOADING_MS` is reported slow and the guard keeps waiting.
 *
 * A stray happens at most once per placement and is never undone here: whoever holds the guard
 * takes the frame down and offers to place it again. Nothing resets on its own, so a page that
 * keeps navigating cannot make the parent loop.
 *
 * A guard given `onsignin` hands over a frame whose document says, before its handshake, that it
 * was refused for want of a session (`ARTIFACT_SIGN_IN`): it calls the hook and says nothing more,
 * so its holder can refresh the session and place the frame again. Without the hook the notice is
 * just a document that answered, and is shown.
 */
export class FrameGuard {
  readonly nonce: string;
  #state: "waiting" | "accepted" | "stray" | "disposed" = "waiting";
  #loads = 0;
  #handshook = false;
  #slow: ReturnType<typeof setTimeout> | undefined;
  #grace: ReturnType<typeof setTimeout> | undefined;
  #hooks: GuardHooks;

  constructor(
    hooks: GuardHooks,
    nonce: string = frameNonce(),
  ) {
    this.nonce = nonce;
    this.#hooks = hooks;
    this.#slow = setTimeout(() => {
      if (this.#state === "waiting") this.#hooks.onslow?.();
    }, STILL_LOADING_MS);
  }

  get state(): "waiting" | "accepted" | "stray" | "disposed" {
    return this.#state;
  }

  /** The frame fired `load`. */
  load(): void {
    if (this.#state === "stray" || this.#state === "disposed") return;
    this.#loads += 1;
    if (this.#loads > 1) return this.#stray();
    if (this.#handshook) return this.#accept();
    clearTimeout(this.#grace);
    this.#grace = setTimeout(() => this.#stray(), HANDSHAKE_GRACE_MS);
  }

  /**
   * A `message` that may be the frame's. `fromFrame` is whether its source is the frame's window:
   * a handshake must be, while a document that is already unloading posts with no source left, so
   * a leaving notice counts on its nonce alone. Only the frame's own document ever held the nonce.
   */
  message(data: unknown, fromFrame: boolean): void {
    if (this.#state === "stray" || this.#state === "disposed") return;
    if (typeof data !== "object" || data === null) return;
    const { type, nonce } = data as { type?: unknown; nonce?: unknown };
    // Anything without the nonce could have come from any document in the frame, so it says
    // nothing either way.
    if (nonce !== this.nonce) return;
    if (type === ARTIFACT_LEAVING) return this.#stray();
    if (type === ARTIFACT_SIGN_IN) {
      // Before its handshake and from the frame itself, or it is not the notice.
      if (!fromFrame || this.#handshook || this.#hooks.onsignin === undefined) return;
      this.#state = "disposed";
      this.#clear();
      return this.#hooks.onsignin();
    }
    if (type !== ARTIFACT_LOADED || !fromFrame) return;
    if (this.#handshook) return this.#stray();
    this.#handshook = true;
    if (this.#loads === 1) this.#accept();
  }

  /** The frame is gone: stop every timer, and say nothing more. */
  dispose(): void {
    this.#state = "disposed";
    this.#clear();
  }

  #accept(): void {
    this.#clear();
    this.#state = "accepted";
    this.#hooks.onaccept();
  }

  #stray(): void {
    if (this.#state === "stray" || this.#state === "disposed") return;
    this.#clear();
    this.#state = "stray";
    this.#hooks.onstray();
  }

  #clear(): void {
    clearTimeout(this.#slow);
    clearTimeout(this.#grace);
  }
}

type GuardHooks = {
  onaccept: () => void;
  onstray: () => void;
  onslow?: () => void;
  onsignin?: () => void;
};

/** One placed frame, as the stage drives it. The DOM side lives with whoever opens it. */
export interface StageFrame {
  /** The frame's window, which a handshake's `source` must be. */
  readonly window: unknown;
  /** Make a frame that loaded hidden behind the one on screen visible. */
  reveal(): void;
  remove(): void;
}

/** Places a frame named `nonce` at `url`, hidden when another is on screen. */
export type OpenStageFrame = (
  options: { url: string; nonce: string; hidden: boolean; onload: () => void },
) => StageFrame;

/** What a guarded artifact view shows. */
export type StageView = {
  /** The version on screen, which said it loaded. */
  shown: number | null;
  /** The version loading, behind the one on screen or alone. */
  pending: number | null;
  /** The loading version has gone `STILL_LOADING_MS` without saying it loaded. */
  slow: boolean;
  /** The version whose page tried to leave and was taken down, until something is placed again. */
  stopped: number | null;
};

/**
 * The session a frame's document is loaded with. Its content route never refreshes it (frames
 * loading side by side would race to rotate the one refresh token), so the view does, through the
 * one deduplicated refresh the rest of the app uses.
 */
export interface FrameSession {
  /** Settles once the session will outlast a frame's load, after a refresh if it would not. */
  ready(): Promise<unknown>;
  /** A frame was refused for want of a session: refresh. Settles once that is done, either way. */
  renew(): Promise<unknown>;
}

/**
 * The frames of one guarded artifact view: the version on screen and at most one loading.
 *
 * A new version loads hidden behind the one on screen and replaces it once its guard accepts it,
 * so switching versions never flashes empty. If the loading version strays, only it is taken down:
 * the one on screen stays, and `stopped` names the one that strayed. If the version on screen
 * strays, every frame is taken down. Nothing is placed again until `place` is called.
 *
 * Given a `session`, a frame is opened only once `session.ready()` settles, and a frame refused for
 * want of a session (`ARTIFACT_SIGN_IN`) is taken down, the session renewed, and the same version
 * opened once more. That second frame shows whatever it gets, the sign-in notice included, so a
 * session that cannot be renewed costs one refresh and one reload per `place`, never a loop.
 * While the session is being seen to, the version counts as loading and the one on screen stays.
 */
export class FrameStage {
  #open: OpenStageFrame;
  #onchange: (view: StageView) => void;
  #shown: StagePlacement | null = null;
  #pending: StagePlacement | null = null;
  #slow = false;
  #stopped: number | null = null;
  #session: FrameSession | null;
  /** A version waiting on the session before its frame is opened. */
  #waiting: { version: number; url: string } | null = null;

  constructor(
    open: OpenStageFrame,
    onchange: (view: StageView) => void,
    session: FrameSession | null = null,
  ) {
    this.#open = open;
    this.#onchange = onchange;
    this.#session = session;
  }

  get view(): StageView {
    return {
      shown: this.#shown?.version ?? null,
      pending: this.#pending?.version ?? this.#waiting?.version ?? null,
      slow: this.#slow,
      stopped: this.#stopped,
    };
  }

  /** Show `version`, served at `url`. The one on screen already, at the same url, is left alone. */
  place(version: number, url: string): void {
    this.#drop(this.#pending);
    this.#pending = null;
    this.#waiting = null;
    this.#slow = false;
    this.#stopped = null;
    if (this.#shown?.version === version && this.#shown.url === url) return this.#changed();
    if (this.#session === null) return this.#openFrame(version, url, false);
    this.#after(this.#session.ready(), version, url, true);
  }

  /** Opens `version` once `settled` settles, unless something else was placed meanwhile. */
  #after(settled: Promise<unknown>, version: number, url: string, mayRenew: boolean): void {
    const ticket = { version, url };
    this.#waiting = ticket;
    this.#changed();
    const go = () => {
      if (this.#waiting !== ticket) return;
      this.#waiting = null;
      this.#openFrame(version, url, mayRenew);
    };
    settled.then(go, go);
  }

  #openFrame(version: number, url: string, mayRenew: boolean): void {
    const session = this.#session;
    const guard: FrameGuard = new FrameGuard({
      onaccept: () => {
        if (this.#pending !== placement) return;
        this.#drop(this.#shown);
        this.#shown = placement;
        this.#pending = null;
        this.#slow = false;
        placement.frame.reveal();
        this.#changed();
      },
      onstray: () => {
        if (this.#pending === placement) {
          this.#drop(placement);
          this.#pending = null;
          this.#slow = false;
        } else if (this.#shown === placement) {
          this.#drop(this.#shown);
          this.#drop(this.#pending);
          this.#shown = null;
          this.#pending = null;
          this.#slow = false;
        } else return;
        this.#stopped = version;
        this.#changed();
      },
      onslow: () => {
        if (this.#pending !== placement) return;
        this.#slow = true;
        this.#changed();
      },
      onsignin: mayRenew && session !== null
        ? () => {
          if (this.#pending !== placement) return;
          this.#drop(placement);
          this.#pending = null;
          this.#slow = false;
          this.#after(session.renew(), version, url, false);
        }
        : undefined,
    });
    const frame = this.#open({
      url,
      nonce: guard.nonce,
      hidden: this.#shown !== null,
      onload: () => guard.load(),
    });
    const placement: StagePlacement = { version, url, guard, frame };
    this.#pending = placement;
    this.#changed();
  }

  /** A `message` the window got. */
  message(data: unknown, source: unknown): void {
    for (const p of [this.#shown, this.#pending]) {
      p?.guard.message(data, source !== null && source === p.frame.window);
    }
  }

  /** Take every frame down for good. */
  dispose(): void {
    this.#drop(this.#shown);
    this.#drop(this.#pending);
    this.#shown = null;
    this.#pending = null;
    this.#waiting = null;
  }

  #drop(p: StagePlacement | null): void {
    if (p === null) return;
    p.guard.dispose();
    p.frame.remove();
  }

  #changed(): void {
    this.#onchange(this.view);
  }
}

type StagePlacement = { version: number; url: string; guard: FrameGuard; frame: StageFrame };
