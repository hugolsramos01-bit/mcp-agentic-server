# Contributing to Agentic MCP

First of all, thanks for taking the time to contribute!

## Development Environment Setup

1. Clone the repository
2. Install dependencies with `npm install`
3. Build the project with `npm run build`
4. Start the server in watch mode: `npm run dev`

## Pull Request Process

1. Ensure your code passes all linting and type checks (`npm run typecheck`).
2. Add or update tests as appropriate.
3. Run the test suite (`npm test`) and ensure all tests pass.
4. Update the `README.md` or `docs/` with details of any changes to the interface or behavior.
5. Create a Pull Request with a clear description of the changes and the problem they solve.

## Architectural Notes

- `server.ts` is the main entry point and handles tool registration and the MCP HTTP server.
- Tools are split logically: `assistant-tools.ts`, `semantic-tools.ts`, `tournament-tools.ts`.
- Subagents logic lives under `src/local-agent-*`.
- The `docs/` directory contains deep-dive documentation on security, configuration, and architecture.
