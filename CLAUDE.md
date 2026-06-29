
Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

# Environment Rules
- use bun commands instead of npm and node commands
- when using any bun command prepend it with `bunx cross-env AGENT=1` (for example: `bunx cross-env AGENT=1 bun run test`)
- after implementing your task, run `bun typecheck && bun codecheck:fix && bun run test` and fix any errors until it passes all checks
- use US English spelling over British English spelling

# Code Architecture Rules
- use Domain-Driven Design principles and adhere to Hexagonal Architecture
- dependencies should flow as Infrastructure -> Application -> Domain, anytime a reverse direction is needed, depend on an abstraction (type import of an interface)
- adhere to SOLID principles
- the code you write should be easy to test by being decoupled and easy to mock, prefer DI over hardwired dependencies
- always write unit tests for code involving non-trivial transformations
- use custom application errors instead of throwing generic errors when possible
- write comments for any non-trivial code concisely explaining it's purpose and functionality
- use JSDoc comments for public / exported functions and modules, or any callables with many or complex parameters
- use consistent logging throughout the application code base through a centralized, configurable, logging provider

# Node.js (Bun) / Typescript Specific Rules
- use type imports for type only imports
- use ?? instead of || for nullish coalescing
- don't use ?? null, if the variable you are coalescing is already nullable
- don't install dotenv, .env is loaded automatically by bun
- don't use the "any" type to resolve type errors, except where it actually makes sense logically
- any type coercions must have a preceding comment explaining why they are necessary or acceptable in the format // (or /*) TYPE COERCION: ..., this applies to project source code, tests are an exception
- use type guards and type narrowing over type coercions where possible
- prefer bind(this / instanceObj), when passing methods as callbacks, to lambda wrappers
- do not export anything out of a file that isn't needed somewhere else. Not-exported should be the default.
- Bun runtime functions should use explicit imports from "bun"
- any function that doesn't need access to "this" should be at module level rather than a method

# Third-Party APIs & SDKs Rules
- use `context7` MCP to look up up-to-date API docs and usage patterns for major libraries (e.g. langchain, @langchain/google, genai) before writing code using them, or when trying to resolve type discrepancies  