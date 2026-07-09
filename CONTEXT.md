# Glossary

The project's ubiquitous language. Terms only — no implementation details.

## Settle up

The **action / flow** of squaring debts within a group: the `/groups/[id]/settle`
page shows suggested transfers and each row's "Settle up" button starts recording
one. It names the _activity_, not a data category. The button, nav item, and page
title stay "Settle up".

## Debt settlement

The transfer **category** (`transfer-debt-settlement`) applied to a transaction
that repays a debt, and the default **title** seeded when a transaction is created
via the Settle up flow. Distinct from "Settle up": that is the action, this is the
resulting transaction's category and title. A Transfer is not necessarily a Debt
settlement — other transfer categories are Cash, Bank transfer, and Other.
