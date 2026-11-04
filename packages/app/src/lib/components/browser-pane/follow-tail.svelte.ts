/**
 * Keeps a scroll box at its end while new lines arrive, for as long as the reader is there: scroll
 * up to read something and it stays put; scroll back down and it follows again.
 *
 * An attachment: `{@attach followTail(() => lines.length)}`. The count is what says something
 * arrived; reading it inside an effect of its own keeps the attachment itself from re-running.
 */
export function followTail(count: () => number) {
  return (node: HTMLElement) => {
    let atEnd = true;
    const onScroll = () => {
      atEnd = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    $effect(() => {
      count();
      if (atEnd) node.scrollTop = node.scrollHeight;
    });
    return () => node.removeEventListener("scroll", onScroll);
  };
}
