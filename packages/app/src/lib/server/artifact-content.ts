/**
 * The Content-Security-Policy an artifact's HTML is served under.
 * The control plane serves the same string; a test on each side pins it byte for byte.
 *
 * `sandbox` gives the document an opaque origin even when it is opened on its own, so it never
 * carries the viewer's cookies and cannot read this app. The rest keeps its own requests to the
 * two script CDNs' package paths and Google Fonts. It can still reach the internet in ways a
 * policy does not cover (a popup, navigating its own frame, WebRTC), so the frame around it is
 * guarded too.
 */
export const ARTIFACT_CSP = [
  "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox",
  "default-src 'none'",
  "script-src 'unsafe-inline' https://cdn.jsdelivr.net/npm/ https://cdnjs.cloudflare.com/ajax/libs/",
  "style-src 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net/npm/ " +
  "https://cdnjs.cloudflare.com/ajax/libs/",
  "font-src https://fonts.gstatic.com https://cdn.jsdelivr.net/npm/ " +
  "https://cdnjs.cloudflare.com/ajax/libs/ data:",
  "img-src data: blob:",
  "media-src data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join("; ");

/**
 * Every header an artifact's content goes out with, set here rather than passed on from the
 * control plane: what guards the viewer is this server's to decide. `no-cache` keeps a copy only
 * as long as the control plane says it still matches (`ETag`), and `private` keeps it out of
 * shared caches.
 */
export function artifactContentHeaders(contentType = "text/html; charset=utf-8"): Headers {
  return new Headers({
    "content-type": contentType,
    "content-security-policy": ARTIFACT_CSP,
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
    "cache-control": "private, no-cache",
  });
}

/**
 * The handshake a document in an artifact frame answers its parent with, the same script the
 * control plane puts first in every artifact: it takes the nonce the parent named the frame with,
 * clears the name so nothing after it can read it, posts the nonce back once its own `load`
 * fires, and posts it again on `pagehide`. See `FrameGuard` in $lib/utils/artifacts.
 */
export const ARTIFACT_HANDSHAKE = handshake("");

/**
 * The handshake of a notice that the page needs a session (the content route's 401): before
 * anything else it tells the parent so, with the nonce, which only this document can know. The
 * parent then refreshes the session and loads the frame once more (`FrameStage`); the notice is
 * what stays when that second load is refused too.
 */
export const ARTIFACT_SIGN_IN_HANDSHAKE = handshake(
  'try{p.postMessage({type:"ryph-artifact-sign-in",nonce:n},"*")}catch{}',
);

function handshake(first: string): string {
  return '<script>(()=>{const n=window.name;window.name="";' +
    `const p=parent;${first}let s=0;addEventListener("load",e=>{if(s||!e.isTrusted)return;s=1;` +
    'try{p.postMessage({type:"ryph-artifact-loaded",nonce:n},"*")}catch{}},true);' +
    'addEventListener("pagehide",e=>{if(!e.isTrusted)return;' +
    'try{p.postMessage({type:"ryph-artifact-leaving",nonce:n},"*")}catch{}},true);})();</script>';
}

/**
 * A short notice in the frame, in place of the page, when it cannot be shown. It answers the
 * handshake, so the frame shows it rather than taking it for the page leaving. `signIn` marks the
 * refusal as wanting a session (see `ARTIFACT_SIGN_IN_HANDSHAKE`).
 */
export function artifactNotice(message: string, { signIn = false } = {}): string {
  return `<!doctype html>${
    signIn ? ARTIFACT_SIGN_IN_HANDSHAKE : ARTIFACT_HANDSHAKE
  }<meta name="color-scheme" content="light dark">` +
    `<style>body{margin:0;min-height:100vh;display:grid;place-items:center;` +
    `font:14px/1.5 system-ui,sans-serif;color:GrayText}</style><p>${
      message.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    }</p>`;
}
