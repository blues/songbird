# Songbird Fix Sweep — PR Index

**Date:** 2026-07-02
**Source review:** `review/critical-analysis-2026-07-02.md`
**Scope:** all Critical + High + Medium findings (Low tier deferred as cosmetic cleanup).
**Result:** 37/37 in-scope findings addressed across **36 open PRs** (H7+M1+M2 grouped into one PR). All PRs verified OPEN against `main`, tests green, **none merged** — left for human review.
**Repo:** github.com/blues/songbird · all branches cut fresh off `origin/main`, independent (not stacked).
**Worktrees (left in place for review):** `/Users/satch/Development/blues/songbird-fix/{firmware,infrastructure,dashboard}`

## Summary by component

| Component | Findings | PRs | Status |
|---|---|---|---|
| Firmware | 13 | 12 (C3+C4 grouped) | ✅ complete |
| Infrastructure | 16 | 15 | ✅ complete |
| Dashboard | 9 | 9 | ✅ complete |
| **Total** | **38 finding-IDs (37 cards)** | **36** | ✅ all shipped |

## Critical findings (Telegram-notified as completed)

| ID | PR | Title | Tests |
|---|---|---|---|
| C1 | [#20](https://github.com/blues/songbird/pull/20) | api-config: enforce JWT admin/owner authorization | infra 456 pass |
| C2 | [#22](https://github.com/blues/songbird/pull/22) | api-ingest: require Notehub shared-secret before any write | infra 455 pass + synth |
| C3+C4 | [#24](https://github.com/blues/songbird/pull/24) | Persist device state across sleep via base64 card.attn payload | both pio envs + 96 native tests |

## Full finding → PR table

### Firmware
| ID | Sev | PR | Branch | Test |
|---|---|---|---|---|
| C3+C4 | Critical | [#24](https://github.com/blues/songbird/pull/24) | fix/firmware/c3c4-sleep-payload-persistence | pio ✅ both envs + base64 round-trip tests |
| H3 | High | [#25](https://github.com/blues/songbird/pull/25) | fix/firmware/h3-iwdg-watchdog | pio ✅ (hardware watchdog — not host-testable) |
| H4 | High | [#35](https://github.com/blues/songbird/pull/35) | fix/firmware/h4-state-sync | pio ✅ both envs |
| H5 | High | [#36](https://github.com/blues/songbird/pull/36) | fix/firmware/h5-notecard-i2c-hold | pio ✅ (timing — not host-testable) |
| H6 | High | [#37](https://github.com/blues/songbird/pull/37) | fix/firmware/h6-command-init | pio ✅ + zero-init/termination test |
| H7+M1+M2 | High/Med | [#41](https://github.com/blues/songbird/pull/41) | fix/firmware/h7m1m2-notefile-templates | pio ✅ both envs (grouped: template block) |
| M3 | Med | [#42](https://github.com/blues/songbird/pull/42) | fix/firmware/m3-demo-sync-redundant | pio ✅ both envs |
| M4 | Med | [#44](https://github.com/blues/songbird/pull/44) | fix/firmware/m4-i2c-acquire-errors | pio ✅ both envs |
| M5 | Med | [#45](https://github.com/blues/songbird/pull/45) | fix/firmware/m5-waitconnection-mutex | pio ✅ (timing — not host-testable) |
| M6 | Med | [#47](https://github.com/blues/songbird/pull/47) | fix/firmware/m6-audio-stack | pio ✅ both envs |
| M7 | Med | [#49](https://github.com/blues/songbird/pull/49) | fix/firmware/m7-command-drain | pio ✅ + 96 native tests incl. drain-loop |
| M8 | Med | [#50](https://github.com/blues/songbird/pull/50) | fix/firmware/m8-command-ack-epoch | pio ✅ + 91 native tests |

### Infrastructure
| ID | Sev | PR | Branch | Test |
|---|---|---|---|---|
| C1 | Critical | [#20](https://github.com/blues/songbird/pull/20) | fix/infra/c1-api-config-authz | 456 pass (+5 authz) |
| C2 | Critical | [#22](https://github.com/blues/songbird/pull/22) | fix/infra/c2-ingest-shared-secret | 455 pass + synth |
| H1 | High | [#31](https://github.com/blues/songbird/pull/31) | fix/infra/h1-chat-query-jwt-identity | 453 pass |
| H8 | High | [#27](https://github.com/blues/songbird/pull/27) | fix/infra/h8-mapbox-secret-runtime | 454 pass |
| H9 | High | [#39](https://github.com/blues/songbird/pull/39) | fix/infra/h9-ingest-idempotency | 454 pass |
| H10 | High | [#43](https://github.com/blues/songbird/pull/43) | fix/infra/h10-pitr-retain | 454 pass + synth (PITR×8, RETAIN) |
| M9 | Med | [#30](https://github.com/blues/songbird/pull/30) | fix/infra/m9-cors-restrict-origins | 454 pass |
| M10 | Med | [#46](https://github.com/blues/songbird/pull/46) | fix/infra/m10-wifi-json-escaping | 454 pass |
| M11 | Med | [#48](https://github.com/blues/songbird/pull/48) | fix/infra/m11-alias-toctou | 455 pass |
| M12 | Med | [#51](https://github.com/blues/songbird/pull/51) | fix/infra/m12-alerts-status-shard | 458 pass + synth (sharded GSI) |
| M13 | Med | [#53](https://github.com/blues/songbird/pull/53) | fix/infra/m13-scan-to-gsi | 451 pass (assigned-to-index; 6 scans documented as follow-ups) |
| M14 | Med | [#54](https://github.com/blues/songbird/pull/54) | fix/infra/m14-apigw-throttling | 454 pass + synth (throttling; note: WAFv2 can't attach to HTTP API) |
| M15 | Med | [#52](https://github.com/blues/songbird/pull/52) | fix/infra/m15-redact-logs | 464 pass (+12 redactor tests) |
| M16 | Med | [#55](https://github.com/blues/songbird/pull/55) | fix/infra/m16-llm-sql-guard | 471 pass (SQL guard tests) |
| X1 (cross) | High | [#40](https://github.com/blues/songbird/pull/40) | fix/infra/x1-ingest-app-health-qo | 455 pass (ingest app health.qo; pairs w/ firmware M1 #41) |

### Dashboard
| ID | Sev | PR | Branch | Test |
|---|---|---|---|---|
| H2 | High | [#21](https://github.com/blues/songbird/pull/21) | fix/dashboard/h2-eslint-config | lint exit 0 + tsc + 394 tests |
| H11 | High | [#23](https://github.com/blues/songbird/pull/23) | fix/dashboard/h11-gitignore-config | tsc + 394 tests |
| M17 | Med | [#32](https://github.com/blues/songbird/pull/32) | fix/dashboard/m17-devicedetail-usememo | tsc + 394 tests |
| M18 | Med | [#29](https://github.com/blues/songbird/pull/29) | fix/dashboard/m18-commands-resilient-send | tsc + tests |
| M19 | Med | [#38](https://github.com/blues/songbird/pull/38) | fix/dashboard/m19-mutation-onerror-toast | tsc + 395 tests (+toast test) |
| M20 | Med | [#28](https://github.com/blues/songbird/pull/28) | fix/dashboard/m20-public-device-validation | tsc + tests |
| M21 | Med | [#33](https://github.com/blues/songbird/pull/33) | fix/dashboard/m21-notehub-project-config | tsc + 394 tests |
| M22 | Med | [#34](https://github.com/blues/songbird/pull/34) | fix/dashboard/m22-fleet-single-source | tsc + 394 tests |
| M23 | Med | [#26](https://github.com/blues/songbird/pull/26) | fix/dashboard/m23-markdown-url-sanitize | tsc + 394 tests |

## Suggested review/merge order

All 36 branches were cut independently off the same `origin/main`, so PRs touching the same file are individually green but will conflict on merge — the 2nd+ in each cluster needs a rebase after the prior one merges. Order below minimizes rebases: security priority first, then conflict clustering.

### Tier 1 — Critical security (independent files, merge first)
1. [#20](https://github.com/blues/songbird/pull/20) C1 api-config authz
2. [#22](https://github.com/blues/songbird/pull/22) C2 ingest shared-secret
3. [#24](https://github.com/blues/songbird/pull/24) C3+C4 firmware sleep-payload persistence

### Tier 2 — High severity
4. [#21](https://github.com/blues/songbird/pull/21) H2 dashboard ESLint config — **merge before other dashboard PRs** so CI actually lints them
5. [#23](https://github.com/blues/songbird/pull/23) H11 dashboard .gitignore — **rotate the Mapbox token when merging**
6. [#31](https://github.com/blues/songbird/pull/31) H1 chat-query JWT identity
7. [#27](https://github.com/blues/songbird/pull/27) H8 Mapbox secret at runtime
8. [#43](https://github.com/blues/songbird/pull/43) H10 PITR/RETAIN
9. [#35](https://github.com/blues/songbird/pull/35) H4 firmware state mutex
10. [#25](https://github.com/blues/songbird/pull/25) H3 firmware IWDG watchdog

### Tier 3 — cross-component pair (review/merge as a unit)
11. [#41](https://github.com/blues/songbird/pull/41) firmware H7+M1+M2 notefile templates
12. [#40](https://github.com/blues/songbird/pull/40) infra X1 ingest app health.qo — two ends of the health.qo / `gps_power_saving` wire contract

### Tier 4 — Mediums, by conflict cluster (merge each cluster in the given intra-cluster order; later ones rebase onto the prior)
- api-ingest cluster (after #22, #40): [#39](https://github.com/blues/songbird/pull/39) H9 idempotency → [#52](https://github.com/blues/songbird/pull/52) M15 redact logs
- storage-construct cluster (after #43, #39): [#51](https://github.com/blues/songbird/pull/51) M12 alerts shard
- chat-query cluster (after #31): [#53](https://github.com/blues/songbird/pull/53) M13 scan→GSI → [#55](https://github.com/blues/songbird/pull/55) M16 SQL guard
- api-config cluster (after #20): [#46](https://github.com/blues/songbird/pull/46) M10 wifi escaping
- api-construct: [#54](https://github.com/blues/songbird/pull/54) M14 throttling
- firmware SongbirdNotecard.cpp cluster (after #24, #41): [#37](https://github.com/blues/songbird/pull/37) H6 command init → [#49](https://github.com/blues/songbird/pull/49) M7 command drain → [#50](https://github.com/blues/songbird/pull/50) M8 ack epoch
- firmware SongbirdTasks.cpp cluster (after #35): [#36](https://github.com/blues/songbird/pull/36) H5 i2c hold → [#42](https://github.com/blues/songbird/pull/42) M3 demo sync → [#44](https://github.com/blues/songbird/pull/44) M4 i2c errors → [#45](https://github.com/blues/songbird/pull/45) M5 waitconnection
- firmware standalone: [#47](https://github.com/blues/songbird/pull/47) M6 audio stack
- infra standalone: [#30](https://github.com/blues/songbird/pull/30) M9 CORS, [#48](https://github.com/blues/songbird/pull/48) M11 alias TOCTOU
- dashboard DeviceDetail.tsx cluster (after #21): [#32](https://github.com/blues/songbird/pull/32) M17 useMemo → [#33](https://github.com/blues/songbird/pull/33) M21 project config → [#38](https://github.com/blues/songbird/pull/38) M19 onError toast
- dashboard standalone: [#28](https://github.com/blues/songbird/pull/28) M20, [#29](https://github.com/blues/songbird/pull/29) M18, [#34](https://github.com/blues/songbird/pull/34) M22, [#26](https://github.com/blues/songbird/pull/26) M23

Shortcut: merge Tier 1–3 with care, then enable auto-merge on Tier 4 PRs and let GitHub serialize them — conflicting ones will flag "needs rebase" and can be resolved on the fly.

## Requires human action

- **H11 — ROTATE THE MAPBOX TOKEN.** PR #23 only untracks `public/config.json` + hardens `.gitignore`. The exposed token was NOT rotated/deleted by the agents (per constraint). Brandon must rotate it manually and scope it by URL. The token also remains in git history — consider history scrub if it was ever a private/secret-scoped token.

## Follow-ups documented inside PRs (not full fixes)

- **M12 (#51):** added a non-destructive sharded `status-shard-index`; full migration (backfill → reader switch → retire legacy `status-index`) documented in the PR, not executed.
- **M13 (#53):** converted the highest-value scan (device assignment) to a GSI query; 6 remaining scans (api-activity ×6 time-series, api-devices, api-alerts, api-users:147, api-commands, chat-query) documented as follow-ups needing their own GSI/time-series table design.
- **M14 (#54):** API Gateway stage throttling + per-route limit on the public endpoint. WAFv2 cannot attach to API Gateway **HTTP (v2)** APIs — noted in PR; a REST-API or CloudFront-WAF path is the follow-up if WAF is required.
- **M16 (#55):** hardened validation (single-statement, comment rejection, table + leading-keyword allow-list, catalog block, re-check of rewritten SQL). Full parameterization / RLS / dedicated read-only Postgres role documented as follow-ups.

## Notes

- **Grouping:** C3+C4 (one PR, shared sleep-payload path) and H7+M1+M2 (one PR, shared notefile-template block). Every other finding = its own independent PR.
- **Cross-component pairs:** firmware H7 (#41) ↔ infra ingest reads `gps_power_saving`; firmware M1 (#41, app health.qo template) ↔ infra X1 (#40, ingest app health.qo handling). Each side fixed its own end; PR bodies cross-reference.
- **Not host-testable (stated in PR, gated on clean build instead of a fabricated test):** H3 (IWDG watchdog), H5 & M5 (I2C mutex timing).
- **Commits** authored under Brandon's global identity `bsatrom+gh@gmail.com`. No PR merged; no force-push to main.
- **Delivery:** executed as 5 sequential waves (subagent 50-tool-call budget + one mid-run credit exhaustion) — every PR verified OPEN via `gh pr view` before its Kanban card was closed. No fabricated PR URLs or test output.
- **Kanban:** `songbird` board — 37 finding cards + 1 umbrella, all `done`. The 3 Critical cards + umbrella were Telegram-notified (chat 8509086746).
