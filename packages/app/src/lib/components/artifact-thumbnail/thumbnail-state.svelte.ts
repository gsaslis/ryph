export class ThumbnailState {
  loaded = $state(false);
  failed = $state(false);

  constructor(readonly src: string) {}

  load() {
    if (!this.failed) this.loaded = true;
  }

  fail() {
    this.failed = true;
    this.loaded = false;
  }
}

export function artifactThumbnailHref(id: string, version: number): string {
  return `/artifacts/${encodeURIComponent(id)}/v/${version}/thumbnail`;
}
