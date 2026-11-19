# git-forge

[![github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Pirgo16/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Pirgo16/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01)

One Node process that serves a GitHub-compatible forge from memory: git smart HTTP (push, clone, shallow clone), the REST v3 resources the suite drives, GraphQL queries and mutations, and MCP tools. Nothing is installed and the git binary is not used. Object ids, packfiles and pkt-lines are implemented here; timestamps and randomness stay out of stored state.

`main.ts` binds an ephemeral port, registers it with the suite, and polls until the trial is done.
