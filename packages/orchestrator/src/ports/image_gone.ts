// The one launch failure the core acts on beyond "it failed": the image is gone from the machine
// for good. An environment image a local builder made lives in one daemon's store and no
// registry has it, so a prune, a daemon reset or retention removing it leaves a row still
// `ready` on it naming nothing. A check launcher (`CheckLauncher.launch`) and a provisioner
// (`Provisioner.launch`) throw this, and only on the backend's own word that the image is not
// there: a generic launch failure is never read as one.

/** A launch found its image gone from the machine, and no pull brings it back. */
export class ImageGone extends Error {}
