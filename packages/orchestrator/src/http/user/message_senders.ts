// Who said what to a run, as a person reading its transcript sees it.
//
// A person's message is stored with their user id and nothing else (`MessageSender`): the id is
// what attribution and the attended clock key on, and a name frozen into the row would go stale
// the day its owner renames themselves. The views that embed a run's inbox for a person — the
// task page, a response — name the sender here instead, at read time.
//
// The cost is bounded by the people, not the messages: the distinct senders of a task are
// collected across every run it embeds and each is read once, in parallel — one primary-key read
// of auth's user row apiece (adapters/identity_directory/auth_store.ts). The reader's own name
// comes off their principal, so a task only its requester spoke to — nearly all of them — reads
// nothing at all.

import type { MessageSender, RunMessage } from "../../core/types.ts";
import type { IdentityDirectory } from "../../ports/identity_directory.ts";
import type { Principal } from "../app.ts";

/** The user id RYPH_AUTH=off speaks as; it names no one in the directory. */
const BREAK_GLASS = "break-glass";

/**
 * A message's sender as a person's view reads it: a person carries their display name beside
 * their id. `name` is null only when the directory said they are no longer an active member
 * (deleted or deactivated). It is absent when nobody could say — no directory in this
 * deployment, or the lookup failed — so the view names them neutrally rather than calling an
 * active colleague a former member.
 */
export type NamedMessageSender =
  | Exclude<MessageSender, { kind: "user" }>
  | { kind: "user"; userId: string; name?: string | null };

export type NamedRunMessage = Omit<RunMessage, "sender"> & { sender: NamedMessageSender };

/**
 * Names the people in several inboxes at once, each batch in its order — one directory read per
 * distinct person across all of them, none for the reader. Everything else passes through as is.
 */
export async function nameSenders(
  directory: IdentityDirectory | null | undefined,
  caller: Principal,
  inboxes: readonly (readonly RunMessage[])[],
): Promise<NamedRunMessage[][]> {
  // A name, null for a former member, or undefined for someone nobody could name.
  const known = new Map<string, string | null | undefined>();
  if (caller.kind === "user") known.set(caller.userId, caller.name);
  known.set(BREAK_GLASS, null);

  const unknown = new Set<string>();
  for (const inbox of inboxes) {
    for (const { sender } of inbox) {
      if (sender.kind === "user" && !known.has(sender.userId)) unknown.add(sender.userId);
    }
  }
  // A label is cosmetic: a failed lookup leaves that one person unnamed rather than failing the
  // whole read of the task.
  const read = await Promise.all(
    [...unknown].map(async (id) =>
      [id, directory ? await directory.nameFor(id).catch(() => undefined) : undefined] as const
    ),
  );
  for (const [id, name] of read) known.set(id, name);

  const named = (sender: MessageSender): NamedMessageSender => {
    if (sender.kind !== "user") return sender;
    const name = known.get(sender.userId);
    return name === undefined ? sender : { ...sender, name };
  };
  return inboxes.map((inbox) =>
    inbox.map((message): NamedRunMessage => ({ ...message, sender: named(message.sender) }))
  );
}
