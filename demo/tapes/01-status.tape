# Demo 1 — one screen shows every provider's health, model and token share.
# Vertical framing for Xiaohongshu. Width must fit the CLI's 72-char rules
# without wrapping: at FontSize 20 the 1080px frame holds ~78 columns.
Output demo/out/01-status.mp4

Require ai

Set Shell zsh
Set FontSize 20
Set Width 1080
Set Height 1120
Set Padding 24
Set TypingSpeed 55ms
Set Theme "Catppuccin Mocha"

Hide
Type "export AI_GATEWAY_HOME=/tmp/axiom-demo && export PS1='$ ' && clear"
Enter
Sleep 1s
Show

Type "ai status"
Sleep 400ms
Enter
Sleep 7s

Screenshot demo/out/01-status.png
Sleep 2s
