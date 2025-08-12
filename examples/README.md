# Qapish Examples

This directory contains runnable examples showing how to use the Qapish packages in real code.

---

## Prerequisites

- **Node.js** 18+ (20+ recommended)
- **pnpm** 8+ installed globally:
  ```bash
  npm install -g pnpm
````

---

## 1. Install dependencies

From the root of the repository:

```bash
pnpm install
```

This installs dependencies for all workspaces, including the `examples` directory.

---

## 2. Build all workspace packages

```bash
pnpm build
```

This compiles all TypeScript packages into their distributable form so examples can import them.

---

## 3. Run the `node-basic` example

The `node-basic` example connects to a Substrate-based node via WebSocket, fetches basic chain info, and disconnects.

From the root of the repo:

```bash
pnpm --filter node-basic start -- --endpoint=ws://127.0.0.1:9944 --sig-variant ml-dsa-65
```

> **Tip:** Replace `ws://127.0.0.1:9944` with your own node's WebSocket endpoint and `ml-dsa-65` with your own signature variant. ie:

```bash
pnpm --filter node-basic start -- --endpoint=wss://a.t.res.fm --sig-variant ml-dsa-87
```

---

## 4. Example output

When run against a local development node (`substrate --dev`), you'll see:

```
Connecting to ws://127.0.0.1:9944...
Chain name: Development
Chain type: Local
Node name: Substrate Node
Node version: 4.0.0-dev
Done.
```

---

## 5. Passing additional CLI arguments

The script accepts extra CLI flags:

```bash
pnpm --filter node-basic start -- --endpoint=ws://localhost:9944 --verbose
```

In `src/index.ts`, CLI arguments are read from:

```ts
process.argv.slice(2)
```

---

## 6. Layout

```
examples/
  node-basic/
    package.json    # Config for the example
    src/
      index.ts      # Example code
```

---

## 7. Running other examples

Replace `node-basic` with another example name:

```bash
pnpm --filter <example-name> start -- [args...]
```
