import { getContext, setContext } from "svelte";
import { attachmentUrl } from "$lib/api/attachments";

// Where a page's attachment thumbnails read their bytes from. Every real page leaves this unset
// and gets the control plane's proxy. A dev preview, which has no run behind it, sets it to hand
// out images it drew itself.

const KEY = Symbol("attachment-url");

export type AttachmentUrlOf = (runId: string, attachmentId: string) => string;

export function setAttachmentUrlContext(urlOf: AttachmentUrlOf): void {
  setContext(KEY, urlOf);
}

export function getAttachmentUrlContext(): AttachmentUrlOf {
  return getContext<AttachmentUrlOf | undefined>(KEY) ?? attachmentUrl;
}
