import tailwindcss from "@tailwindcss/vite";
import adapter from "@sveltejs/adapter-node";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    tailwindcss(),
    sveltekit({
      compilerOptions: {
        // Force runes mode for the project, except for libraries. Can be removed in svelte 6.
        runes: ({ filename }) =>
          filename.split(/[/\\]/).includes("node_modules") ? undefined : true,
      },

      // adapter-node: the app ships as a self-hosted Node server (build/index.js), serving the
      // BFF proxy and the built client. See https://svelte.dev/docs/kit/adapter-node.
      adapter: adapter(),
    }),
  ],
  server: {
    fs: {
      // The workspace root, spelled out. bun keeps every npm package in the ROOT node_modules/.bun
      // store and only symlinks it into packages/app/node_modules; Vite serves files by their real
      // path, so anything a stylesheet references at runtime — a @fontsource woff2 — comes out as
      // /@fs/<repo>/node_modules/.bun/… and, with the allow list ending at packages/app, is
      // refused with a 403. Vite finds this root by itself from the root package.json's
      // `workspaces`; naming it keeps that from hanging on Vite's search. Only `vite dev` is
      // affected: a build copies the file into the bundle.
      allow: [decodeURIComponent(new URL("../..", import.meta.url).pathname)],
    },
  },
});
