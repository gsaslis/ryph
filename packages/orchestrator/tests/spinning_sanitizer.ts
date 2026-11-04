// A sanitizer process that never answers, for tests/artifact_html_test.ts: it spins on its one
// thread, deaf to its budget. What a path the parse's own clock misses would make the real one do.

while (true) {
  // Burning a core until SIGKILL.
}
