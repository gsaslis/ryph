// A sanitizer process the kernel's OOM killer took, for tests/artifact_sanitizer_test.ts: it
// SIGKILLs itself, as the kernel would, without answering.

process.kill(process.pid, "SIGKILL");
