- Favour merging routine stable patch/minor updates when the dependency diff is focused,
  relevant tests pass, and inspection finds no concrete incompatibility or security concern.
- Sparse release notes or incomplete upstream diffs may be accepted for those routine updates
  if repository inspection establishes that passing tests meaningfully exercise the affected
  dependency usage. Explain the evidence relied on and the remaining uncertainty in findings.
- Compatible bug fixes and additive features may change behaviour without requiring a skip.
  Distinguish known breakage from hypothetical risk; do not demand proof of zero risk.
- Development-only status and semver are supporting signals, never sufficient evidence alone.
  Lint-only CI cannot substitute for coverage of runtime or test-tool behaviour.
- Major and pre-1.0 minor updates still require explicit compatibility evidence. Skip for
  specific unresolved risks to this repository that available tests do not address; never
  inflate confidence or lower risk just to authorize a merge under this policy.
