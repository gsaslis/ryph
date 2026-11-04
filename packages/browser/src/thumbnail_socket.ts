// Socket mode is for a trusted, renderer-owned shared volume, not an arbitrary /tmp path.
import { lstat, realpath, unlink } from "node:fs/promises";
import { connect } from "node:net";
import { dirname, isAbsolute, resolve } from "node:path";

export async function prepareThumbnailSocket(path: string): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new Error("thumbnail socket must be an absolute, normalized path");
  }
  const parent = dirname(path);
  const directory = await lstat(parent);
  const uid = process.geteuid?.();
  if (
    uid === undefined || !directory.isDirectory() || directory.uid !== uid ||
    (directory.mode & 0o022) !== 0 || await realpath(parent) !== parent
  ) {
    throw new Error(
      "thumbnail socket directory must be renderer-owned, non-symlinked and not group/world-writable",
    );
  }
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!existing) return;
  if (!existing.isSocket() || existing.uid !== uid) {
    throw new Error("refusing to replace a non-socket or foreign-owned thumbnail socket");
  }
  // Only ECONNREFUSED proves a stale socket. A live listener, timeout, permission error,
  // or any ambiguous state refuses startup instead of disrupting another process.
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ path });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("could not establish whether thumbnail socket is stale"));
    }, 500);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error("thumbnail socket already has a listener"));
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      socket.destroy();
      if (error.code === "ECONNREFUSED") resolve();
      else reject(error);
    });
  });
  const current = await lstat(path);
  if (
    !current.isSocket() || current.uid !== uid ||
    current.dev !== existing.dev || current.ino !== existing.ino
  ) {
    throw new Error("thumbnail socket changed during stale-socket check");
  }
  await unlink(path);
}
