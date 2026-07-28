# Contributing to Hikaru Music Bot

Thanks for your interest in contributing! This guide will help you get started.

## Development Setup

```bash
# 1. Fork the repository

# 2. Clone your fork
git clone https://github.com/YOUR_USERNAME/Hikaru-music-bot-discord.git
cd Hikaru-music-bot-discord

# 3. Install dependencies
npm install

# 4. Create a branch
git checkout -b feature/your-feature-name

# 5. Make your changes

# 6. Test locally
node --check src/index.js
node --check src/*.js
node --check src/commands/*.js

# 7. Commit and push
git add -A
git commit -m "feat: add your feature description"
git push origin feature/your-feature-name

# 8. Open a Pull Request
```

## Project Structure

```
src/
├── config.js          ← .env + constants (add new config here)
├── stream.js          ← audio streaming pipeline (yt-dlp → ffmpeg)
├── PlayerUI.js        ← embed + button builders
├── MusicManager.js    ← core class (play, skip, queue, volume)
├── commands/
│   └── index.js       ← slash command definitions
└── index.js           ← Discord client + event routing
```

## Guidelines

### Code Style
- Use `const` and `let` — no `var`
- Use async/await — no `.then()` chains
- Keep functions small and focused
- Comment complex logic

### Adding a New Command
1. Add `SlashCommandBuilder` in `src/commands/index.js`
2. Add `case` in `src/index.js` → `handleCommand()`
3. Update README commands table
4. Test with `/play` first (ensure music player works)

### Adding Audio Filters
1. Add filter args in `src/stream.js` → `makePipeEncode()`
2. Add command in `src/commands/index.js`
3. Handle in `src/index.js` → `handleCommand()`

### Commits
Follow [Conventional Commits](https://www.conventionalcommits.org/):
- `feat:` — new feature
- `fix:` — bug fix
- `docs:` — documentation
- `refactor:` — code change that neither fixes a bug nor adds a feature
- `test:` — adding tests

### Pull Requests
- Keep PRs focused — one feature/fix per PR
- Include description of what changed and why
- Test before submitting: `node --check src/index.js`
- Reference issues if applicable: `Fixes #123`

## Reporting Issues

Open a GitHub issue with:
1. **Description** — what happened vs what you expected
2. **Steps to reproduce** — how to trigger the bug
3. **Environment** — Node.js version, OS, PM2 or Docker
4. **Logs** — `pm2 logs music-bot --lines 50`

## Feature Requests

Open an issue with:
1. **Description** — what you want
2. **Use case** — why you want it
3. **Alternatives** — what you considered

## Questions?

Open a GitHub Discussion or issue with the `question` label.
