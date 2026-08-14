# Demo 3 — `ai doctor` proves the install is sane before anything runs.
# PATH is pinned to the demo stubs so no /Users/<name>/... path is ever shown.
Output demo/out/03-doctor.mp4

Require ai

Set Shell zsh
Set FontSize 20
Set Width 1440
Set Height 700
Set Padding 26
Set TypingSpeed 55ms
Set Theme "Catppuccin Mocha"

Hide
Type "export AI_GATEWAY_HOME=/tmp/axiom-demo"
Enter
Type "export PATH=/tmp/axiom-demo/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin"
Enter
Type "export PS1='$ ' && clear"
Enter
Sleep 1s
Show

Type "ai doctor --local"
Sleep 400ms
Enter
Sleep 7s

Screenshot demo/out/03-doctor.png
Sleep 2s
