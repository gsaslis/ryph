import { dev } from "$app/environment";
import { error } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

/** A scratch page for the agent throbber. Dev only: anywhere else it is a 404. */
export const ssr = false;

export const load: PageLoad = () => {
  if (!dev) error(404, "Not found");
  return { breadcrumb: "Throbber" };
};
