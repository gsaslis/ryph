import type { PageLoad } from "./$types";
import { retryOf } from "./notice";

export const load: PageLoad = ({ url }) => ({ retry: retryOf(url) });
