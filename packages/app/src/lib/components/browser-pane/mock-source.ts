import type {
  LiveAction,
  LiveConsole,
  LiveFrame,
  LiveMessage,
  LiveNetwork,
  LiveSource,
  LiveStatus,
  LiveTab,
  LiveTarget,
} from "$lib/api/browser-live";

// A pretend browser, for looking at the pane without a run, a sidecar or a historian. Dev only:
// imported by the dev page and, behind `?browser=mock`, lazily by the run page in dev. It draws a
// small app onto a canvas, encodes each frame as the sidecar would (JPEG, q60, ~10 fps) and acts
// it out: a click, some typing, a request, a console error, a second tab.

const W = 1280;
const H = 800;
const FPS = 10;

/** Where the pretend app's controls sit, in viewport CSS px. */
const INPUT: LiveTarget = { x: 440, y: 330, width: 400, height: 48 };
const BUTTON: LiveTarget = { x: 440, y: 400, width: 140, height: 44 };
const SETTINGS_LINK: LiveTarget = { x: 1090, y: 22, width: 90, height: 28 };

const ORIGIN = "http://localhost:5173";

interface Scene {
  tab: "home" | "settings";
  typed: string;
  greeting: string | null;
  cursor: { x: number; y: number };
  pressed: boolean;
}

export interface MockBrowser {
  source: LiveSource;
  /** The relay drops, as if the runner lost its connection. */
  dropUplink(): void;
  restoreUplink(): void;
  /** The run concludes: the relay goes, and the historian closes the stream. */
  endRun(): void;
}

export function createMockBrowser(): MockBrowser {
  let emit: ((m: LiveMessage) => void) | null = null;
  let uplink = true;
  let ended = false;

  const scene: Scene = {
    tab: "home",
    typed: "",
    greeting: null,
    cursor: { x: 900, y: 600 },
    pressed: false,
  };
  let status: LiveStatus = "idle";
  let tabs: LiveTab[] = [];
  let lastFrame: LiveFrame | null = null;
  const consoleLog: LiveConsole[] = [];
  const networkLog: LiveNetwork[] = [];
  const actionLog: LiveAction[] = [];

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  let tick = 0;

  const send = (m: LiveMessage) => {
    if (uplink && !ended) emit?.(m);
  };

  const now = () => Date.now();
  const activeTabId = () => tabs.find((t) => t.active)?.id ?? "tab-1";

  function draw(): LiveFrame {
    tick++;
    ctx.fillStyle = "#fafaf9";
    ctx.fillRect(0, 0, W, H);
    // The app's bar.
    ctx.fillStyle = "#1e293b";
    ctx.fillRect(0, 0, W, 72);
    ctx.fillStyle = "#f8fafc";
    ctx.font = "600 26px system-ui, sans-serif";
    ctx.fillText("Greeter", 40, 46);
    ctx.font = "18px system-ui, sans-serif";
    ctx.fillText("Settings", SETTINGS_LINK.x + 8, SETTINGS_LINK.y + 21);

    if (scene.tab === "home") {
      ctx.fillStyle = "#0f172a";
      ctx.font = "600 40px system-ui, sans-serif";
      ctx.fillText("Who should we greet?", 440, 280);
      // The input, with a blinking caret.
      ctx.strokeStyle = "#94a3b8";
      ctx.lineWidth = 2;
      ctx.strokeRect(INPUT.x, INPUT.y, INPUT.width, INPUT.height);
      ctx.fillStyle = "#0f172a";
      ctx.font = "22px system-ui, sans-serif";
      ctx.fillText(scene.typed, INPUT.x + 14, INPUT.y + 32);
      if (Math.floor(tick / 5) % 2 === 0) {
        const w = ctx.measureText(scene.typed).width;
        ctx.fillRect(INPUT.x + 16 + w, INPUT.y + 12, 2, 24);
      }
      // The button.
      ctx.fillStyle = scene.pressed ? "#1d4ed8" : "#2563eb";
      ctx.fillRect(BUTTON.x, BUTTON.y, BUTTON.width, BUTTON.height);
      ctx.fillStyle = "#ffffff";
      ctx.font = "600 20px system-ui, sans-serif";
      ctx.fillText("Greet", BUTTON.x + 44, BUTTON.y + 29);
      if (scene.greeting !== null) {
        ctx.fillStyle = "#15803d";
        ctx.font = "600 30px system-ui, sans-serif";
        ctx.fillText(scene.greeting, 440, 520);
      }
    } else {
      ctx.fillStyle = "#0f172a";
      ctx.font = "600 40px system-ui, sans-serif";
      ctx.fillText("Settings", 440, 280);
      ctx.fillStyle = "#b91c1c";
      ctx.font = "22px system-ui, sans-serif";
      ctx.fillText("Could not load your settings (404)", 440, 340);
    }
    // Something always moving, so frames keep coming the way they do on an animating page.
    const spin = (tick / FPS) * Math.PI;
    ctx.strokeStyle = "#cbd5e1";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(W - 60, H - 60, 18, spin, spin + Math.PI * 1.3);
    ctx.stroke();
    // The pointer.
    ctx.fillStyle = "#0f172a";
    ctx.beginPath();
    ctx.moveTo(scene.cursor.x, scene.cursor.y);
    ctx.lineTo(scene.cursor.x, scene.cursor.y + 26);
    ctx.lineTo(scene.cursor.x + 18, scene.cursor.y + 19);
    ctx.closePath();
    ctx.fill();

    const data = canvas.toDataURL("image/jpeg", 0.6).slice("data:image/jpeg;base64,".length);
    return {
      mime: "image/jpeg",
      data,
      width: W,
      height: H,
      tabId: activeTabId(),
      viewport: { width: W, height: H },
    };
  }

  function frame() {
    lastFrame = draw();
    send({ kind: "event", event: { type: "frame", at: now(), frame: lastFrame } });
  }

  function setStatus(next: LiveStatus) {
    status = next;
    send({ kind: "event", event: { type: "status", at: now(), status } });
  }

  function setTabs(next: LiveTab[]) {
    tabs = next;
    send({ kind: "event", event: { type: "tabs", at: now(), tabs } });
  }

  function action(tool: string, summary: string, target?: LiveTarget) {
    const event: LiveAction = { type: "action", at: now(), tool, summary, target };
    actionLog.push(event);
    send({ kind: "event", event });
  }

  function log(level: LiveConsole["level"], text: string, exception = false) {
    const event: LiveConsole = {
      type: "console",
      at: now(),
      tabId: activeTabId(),
      level,
      text,
      source: { url: `${ORIGIN}/src/app.ts`, line: 42 },
      ...(exception ? { exception: true as const } : {}),
    };
    consoleLog.push(event);
    send({ kind: "event", event });
  }

  function request(method: string, path: string, status?: number, failure?: string) {
    const event: LiveNetwork = {
      type: "network",
      at: now(),
      tabId: activeTabId(),
      method,
      url: path.startsWith("http") ? path : `${ORIGIN}${path}`,
      resourceType: path.endsWith(".js")
        ? "script"
        : path.startsWith("/api")
        ? "fetch"
        : "document",
      ...(status === undefined ? {} : { status }),
      ...(failure === undefined ? {} : { failure }),
      durationMs: 20 + Math.round(Math.random() * 180),
    };
    networkLog.push(event);
    send({ kind: "event", event });
  }

  const centre = (t: LiveTarget) => ({ x: t.x + t.width / 2, y: t.y + t.height / 2 });

  /** The story, step by step: each a delay in ms, then what happens. */
  const script: [number, () => void][] = [
    [600, () => setStatus("launching")],
    [800, () => {
      setStatus("active");
      setTabs([{ id: "tab-1", url: `${ORIGIN}/`, title: "Greeter", active: true }]);
      request("GET", "/", 200);
      request("GET", "/src/app.js", 200);
      log("info", "[vite] connected.");
      action("navigate", `Opened ${ORIGIN}/`);
    }],
    [1500, () => {
      scene.cursor = centre(INPUT);
      action("click", "Clicked “Name”", INPUT);
    }],
    ...[..."Ada Lovelace"].map((ch, i): [number, () => void] => [
      i === 0 ? 700 : 90,
      () => (scene.typed += ch),
    ]),
    [100, () => action("type", "Typed into “Name”", INPUT)],
    [1200, () => {
      scene.cursor = centre(BUTTON);
      scene.pressed = true;
      action("click", "Clicked “Greet”", BUTTON);
    }],
    [250, () => {
      scene.pressed = false;
      request("POST", "/api/greet", 200);
      log("log", `greeting ${scene.typed}`);
      scene.greeting = `Hello, ${scene.typed}!`;
    }],
    [1500, () => log("warn", "Greeting took 812 ms; consider caching")],
    [1500, () => {
      scene.cursor = centre(SETTINGS_LINK);
      action("click", "Clicked “Settings”", SETTINGS_LINK);
      scene.tab = "settings";
      setTabs([
        { id: "tab-1", url: `${ORIGIN}/`, title: "Greeter", active: false },
        { id: "tab-2", url: `${ORIGIN}/settings`, title: "Settings · Greeter", active: true },
      ]);
      request("GET", "/settings", 200);
      request("GET", "/api/settings", 404);
      request(
        "GET",
        "https://fonts.example.com/inter.woff2",
        undefined,
        "net::ERR_NAME_NOT_RESOLVED",
      );
      log(
        "error",
        "Uncaught (in promise) Error: settings not found\n    at load (app.ts:42:11)",
        true,
      );
    }],
    [2500, () => {
      scene.tab = "home";
      scene.typed = "";
      scene.greeting = null;
      setTabs([{ id: "tab-1", url: `${ORIGIN}/`, title: "Greeter", active: true }]);
      action("tabs", "Closed a tab");
    }],
    [2000, () => action("scroll", "Scrolled down")],
  ];

  let step = 0;
  let stepTimer: ReturnType<typeof setTimeout> | undefined;
  let frameTimer: ReturnType<typeof setInterval> | undefined;

  function next() {
    const [delay, run] = script[step % script.length];
    stepTimer = setTimeout(() => {
      if (ended) return;
      run();
      step++;
      next();
    }, delay);
  }

  function room(): LiveMessage {
    return {
      kind: "room",
      room: {
        uplink,
        status,
        tabs,
        frame: lastFrame,
        console: consoleLog.slice(-500),
        network: networkLog.slice(-200),
        actions: actionLog.slice(-200),
      },
    };
  }

  // Acted out only while somebody watches: closing the pane stops it where it was.
  let started = false;
  function start() {
    if (started || ended) return;
    started = true;
    next();
    frameTimer = setInterval(() => {
      if (status === "active" && !ended) frame();
    }, 1000 / FPS);
  }

  return {
    source: ({ onMessage, onOpen }) => {
      emit = onMessage;
      start();
      const open = setTimeout(() => {
        onOpen?.();
        onMessage(room());
        if (ended) onMessage({ kind: "done" });
      }, 300);
      return () => {
        clearTimeout(open);
        clearTimeout(stepTimer);
        clearInterval(frameTimer);
        started = false;
        emit = null;
      };
    },
    dropUplink() {
      if (ended || !uplink) return;
      emit?.({ kind: "uplink", connected: false });
      uplink = false;
    },
    restoreUplink() {
      if (ended || uplink) return;
      uplink = true;
      emit?.({ kind: "uplink", connected: true });
      emit?.(room());
    },
    endRun() {
      if (ended) return;
      emit?.({ kind: "uplink", connected: false });
      uplink = false;
      ended = true;
      status = "closed";
      clearTimeout(stepTimer);
      clearInterval(frameTimer);
      emit?.({ kind: "done" });
    },
  };
}
