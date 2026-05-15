# Contributing to taw-computer

Thanks for your interest in contributing! Here's how to get started.

## Development setup

```bash
# Clone the repo
git clone https://github.com/the-agents-work/taw-computer.git
cd taw-computer

# Install dependencies
npm install

# Build the sandbox Docker image
docker build -f images/Dockerfile.taw -t taw-computer-base .

# Run the MCP server
npm start
```

## How to contribute

### Bug reports

Open an [issue](https://github.com/the-agents-work/taw-computer/issues) with:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Your environment (OS, Docker version, Node.js version)

### Feature requests

Open an [issue](https://github.com/the-agents-work/taw-computer/issues) describing:
- The use case / problem you're solving
- Your proposed solution (if you have one)

### Pull requests

1. Fork the repo
2. Create a branch (`git checkout -b my-feature`)
3. Make your changes
4. Run type checking: `npm run typecheck`
5. Test manually with an MCP client (Claude Code, Cursor, etc.)
6. Commit with a descriptive message
7. Push and open a PR

### Adding a new MCP tool

1. Add the tool definition to the `tools` array in `mcp/index.ts`
2. Add the handler in the `handleToolCall` switch statement
3. If the tool needs sandbox interaction, use the `sb` (SandboxManager) API
4. If the tool needs browser interaction, use the `browser` (BrowserController) API
5. Update the README tools table

## Code style

- TypeScript, strict mode
- ES modules (`import/export`)
- Keep it simple — no unnecessary abstractions
- Error messages should be helpful and actionable

## Questions?

Open an issue or start a discussion. We're happy to help!
