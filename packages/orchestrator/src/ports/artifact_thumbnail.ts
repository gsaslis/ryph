// A credential-free, network-isolated renderer. It receives the prepared document with its
// images inlined, never a URL or a user's session. Failure affects a preview, not publication.
export interface ArtifactThumbnailRenderer {
  /** A fixed 1200 × 750 PNG, at most 4 MiB. Implementations bound time and response bytes. */
  render(html: string, signal?: AbortSignal): Promise<Uint8Array>;
}
