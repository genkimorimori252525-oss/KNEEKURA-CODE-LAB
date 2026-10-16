# CI runner selection

Ordinary pull-request checks and push checks use the standard GitHub-hosted
`windows-latest` image. Public repository visibility does not override `runs-on`;
explicit self-hosted labels would otherwise leave these jobs waiting for a PC.
The existing Node setup, tests, package builds, browser acceptance and graph
checks remain enabled. Relay Foundation is test-only and also uses hosted Windows,
retaining its PowerShell commands and read-only token permission.

The existing named `feat/*` live-acceptance push profiles in `ci.yml` retain the
self-hosted label expression because their scripts inspect pre-existing target
clones. This exception does not apply to ordinary PR checks. The privileged
`kneekura-github-relay.yml` executor and other manually triggered local workflows
are unchanged. No visibility, secret, billing, larger-runner or deployment setting
is changed by this runner selection.
