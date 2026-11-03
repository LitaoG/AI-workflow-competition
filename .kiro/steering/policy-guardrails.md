---
inclusion: always
name: security-policy-guardrails
description: Security sandbox boundaries, tool privilege ceilings, and secret exfiltration prevention
---

# Security Policy Guardrails

1. **Destructive Command Ban**: Destructive operations (`rm -rf /`, raw disk formatting, dropping production tables, broad git resets) are unconditionally blocked with exit code 2.
2. **Mandatory Secret Sanitization**: Payloads and environment variables matching sensitive key regexes or sensitive token patterns (`AKIA[0-9A-Z]{16}`, `ghp_[a-zA-Z0-9]{30}`, JWTs, passwords, private keys) must be replaced with `***REDACTED***` prior to persistence.
3. **Least Privilege Ceilings**: Agents must operate within the strict tool grant ceilings defined in `.kiro/crew/permissions.json`.
4. **Deterministic Gate Enclosure**: Gate failures immediately halt or branch the workflow; no silent progression on failed invariants.
