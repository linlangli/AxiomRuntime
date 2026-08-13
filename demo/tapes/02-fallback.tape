# Demo 2 — the money shot: level 1 provider is down, Runtime routes around it.
#
# `ai use claude` is intentionally NOT used here: it spawns the real Claude Code
# TUI, which hijacks the recording with its own prompts. `ai status` shows the
# dead level-1 provider and the healthy fallbacks with real HTTP errors, which
# is the same story without an interactive child process.
Output demo/out/02-fallback.mp4

Require ai

Set Shell zsh
Set FontSize 20
Set Width 1440
Set Height 1000
Set Padding 26
Set TypingSpeed 55ms
Set Theme "Catppuccin Mocha"

Hide
Type "export AI_GATEWAY_HOME=/tmp/axiom-demo && export PS1='$ ' && clear"
Enter
Sleep 1s
Show

# Three providers configured, ranked by level.
Type "ai provider list"
Sleep 400ms
Enter
Sleep 5s

Type "clear"
Enter
Sleep 600ms

# Live health refresh: level 1 answers 502, levels 2 and 3 are ready.
Type "ai status"
Sleep 400ms
Enter
Sleep 7s

Screenshot demo/out/02-fallback.png
Sleep 2s
