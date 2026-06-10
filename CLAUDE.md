# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

## About this project: ulm (user-level memory)

`ulm` は Claude Code 向けの「ユーザーレベル長期記憶」CLI + プラグイン（CLAUDE.md / ref / beads の次に来る "生もの" の記憶レイヤー）。

- ランタイム: Node.js >= 22.5（`node:sqlite`）。**依存パッケージはゼロ・ビルド不要**。新しい依存を足さないこと。
- 構成: `bin/ulm.js`（エントリ）, `src/`（cli/store/gate/context/miner/safepath/exporter/...）, `test/`（`node --test`）, `commands/` `skills/` `hooks/` `.claude-plugin/`（プラグイン）。
- 設計の中核は `DESIGN.md`。特にセキュリティ前提「observation は SessionStart で自動注入される特権チャネル」を崩さないこと。
- 変更後は必ず `node --test test/*.test.js` を通すこと。
- 機密ゲート（`src/gate.js`）・パス検証（`src/safepath.js`）・人間ゲート（approve/promote の TTY 必須）は安全機構。緩める変更は避ける。

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:7510c1e2 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->


## Build & Test

_Add your build and test commands here_

```bash
# Example:
# npm install
# npm test
```

## Architecture Overview

_Add a brief overview of your project architecture_

## Conventions & Patterns

_Add your project-specific conventions here_
