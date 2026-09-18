# Chat-isolation demo

Run one real A/A/B test. On macOS, the demo creates a temporary public trust bundle from the current system and login keychains when needed for the configured proxy:

```sh
npm run demo:chat-isolation
```

It creates two new chat IDs and makes three Codex calls:

1. Chat A receives a random phrase.
2. Chat A receives another message and must recall that phrase.
3. Chat B starts as a separate chat; its output and private Codex thread are
   checked to ensure the phrase from Chat A did not enter it.

The terminal output is intentionally short. A JSON report containing generated
chat IDs, thread IDs, run IDs, and the three pass/fail assertions is saved in a
temporary directory and its path is printed at the end.

To use a specific public CA bundle instead, set `ISOLATED_HARNESS_DEMO_TRUSTED_CA` to a real PEM file path. `AEGIS_DEMO_TRUSTED_CA` and `CHR_DEMO_TRUSTED_CA` remain accepted for compatibility.
