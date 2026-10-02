- Require sufficient evidence from release notes or upstream changes, repository usage, and
  relevant CI to reasonably establish compatibility; exhaustive upstream inspection is unnecessary.
- For stable patch/minor updates, a focused dependency diff, adequate release notes, compatible
  usage, and relevant passing CI normally support merging. Missing or truncated upstream diffs
  alone are not blockers when the remaining evidence is sufficient.
- Skip when a specific evidence gap could plausibly conceal an incompatibility affecting this
  repository and the available checks do not address it. Note minor, non-blocking uncertainties
  in findings rather than escalating them into a skip.
