import { dev } from "$app/environment";
import { error } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

/** A look at the run browser's pane against a pretend browser. Not part of a production build's
 * routes: anywhere but the dev server it is a 404. */
// The pretend browser draws on a canvas, which only a browser has.
export const ssr = false;

export const load: PageLoad = () => {
  if (!dev) error(404, "Not found");
  return { breadcrumb: "Browser preview" };
};
