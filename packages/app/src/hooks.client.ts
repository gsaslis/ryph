import type { HandleClientError } from "@sveltejs/kit";
import { describeError } from "$lib/utils/page-error";

export const handleError: HandleClientError = ({ error, status, message }) =>
  describeError(error, status, message);
