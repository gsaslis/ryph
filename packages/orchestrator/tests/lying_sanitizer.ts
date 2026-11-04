// A sanitizer process that answers a served document without the preamble, for
// tests/artifact_sanitizer_test.ts: what a sanitizer gone wrong would hand back, which the parent
// must never store.

console.log(JSON.stringify({ kind: "ok", served: "<html><head><script>x</script>", refs: [] }));
