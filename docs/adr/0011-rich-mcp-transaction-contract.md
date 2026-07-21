# ADR-0011 — Rich MCP transaction writes are full-shape, server-derived replacements

- **Status:** Accepted
- **Date:** 2026-07-21

## Context

The ledger supports equal, exact-amount, weighted-share, and itemized transactions.
Flattening these into the original `amount` plus `splitBetween` MCP shape loses raw
amounts, weights, receipt lines, and ordered charges. Asking an agent to calculate
minor units, percentages, charge totals, or resolved shares also duplicates the
ledger's currency and rounding rules in an unreliable client.

## Decision

The original equal-split wire remains backward compatible: omit `splitMode` and send
the total `amount` decimal string plus `splitBetween` member ids. Rich calls are
discriminated by `splitMode`:

- `amount`: total `amount` plus beneficiaries carrying exact decimal-string `amount`s.
- `share`: total `amount` plus beneficiaries carrying integer `shareWeight`s.
- `itemized`: ordered items, each with its own equal/amount/share beneficiaries, and
  optional ordered service, VAT, discount, or tip charges. It has no client total.

Money and percentages are human decimal strings. The server converts money to integer
minor units and percentages to basis points. Array position becomes persisted
`sortOrder`; charges are applied in order, and `running_total` therefore observes all
earlier charges. For itemized writes the server derives the final total, single payer's
amount, and resolved member shares.

`update_transaction` is a complete replacement, not a patch. The agent must call
`get_transaction` first, start from its `editable` object, unwrap authored
`title.value` and item `label.value` strings, and submit the complete target shape.
Omitting an item, beneficiary, or charge removes it. Omitted `paidBy`, `categoryId`,
date, and type retain the existing transaction values; type is not writable.

The current MCP write boundary is intentionally limited to one payer and the group's
settlement currency. Existing multi-payer or foreign-currency rows are not replaced
through MCP because their complete shape cannot yet be expressed safely.

Create idempotency fingerprints the complete validated argument object, including
nested items, beneficiaries, and ordered charges. An identical short-window retry
replays without another transaction or audit row; changing any nested value is a new
intent. Every actual create or replacement retains the existing same-transaction audit
and provenance guarantees.

## Consequences

- Legacy equal clients continue to work unchanged.
- Rich writes preserve authored inputs needed for lossless editing.
- Agent arithmetic cannot become a second source of truth for money or rounding.
- Replacement omissions are destructive to detail, so tool and server instructions
  explicitly require the read-first workflow.
- Multi-payer and foreign-currency MCP replacement remain future work rather than
  being silently flattened.
