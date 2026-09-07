# The QR encoder belongs to `th_promptpay`, and `th_bank_account` has none

ADR-0016 made a rail's QR encoder a rail capability and said the first task of the
QR issue was a **spike**, not a build: confirm against real banking apps that an
account-number-proxy Thai QR scans cross-bank. The spike ran (#82, against K PLUS
and SCB EASY). Its result moves the feature to a different rail, so ADR-0016's
"generated from that `th_bank_account` row" is superseded here.

## What the spike found

**A bank account proxy is rejected.** Four encodings of the account-number sub-tag
— with and without the bank code, padded to three different lengths — errored
outright in both apps. Not a false negative: the same test bench reproduces a
real bank-issued payload byte for byte, CRC included, so the failures are the
proxy being refused rather than a malformed payload.

**A bank's own "receive to this account" QR does not use it either.** One app
emits an e-wallet sub-tag holding a bank-issued identifier that is not the account
number, does not contain it, and is stable across regenerations. Only the bank
knows the mapping, and the user never sees it as digits, so it cannot be typed
into a form. The other bank mints nothing at all and hands out a QR over whatever
PromptPay proxy the user registered.

**The proxies a user can type do work, with the amount.** A mobile-proxy payload
pre-filled the amount in both apps, and a bank ships an ID-card proxy with an
amount field itself. Point of initiation `11` and `12` both scan, and three
different field orders were all accepted — so neither is load-bearing, and the
code pins one of each rather than leaving the choice to drift.

## The decisions

**The encoder is a capability of `th_promptpay`,** over the proxy already stored
there. All three proxy types encode identically and only the sub-tag id changes:
no new field, no new proxy type, no migration.

**`th_bank_account` gets no encoder, and `other` never will.** This is a RESULT,
not a gap — do not re-attempt the account-number sub-tag; that ground is covered.
The registry models this as an optional capability, so a caller asks for a payload
and gets one or `null` without ever asking which rail it is holding: no rail is
privileged (ADR-0016), and one rail having a code no more promotes it than one
rail having a bank list does.

**THB only, and that is correctness rather than polish.** The payload hard-codes
ISO 4217 numeric `764`. There is no way to say "this figure is euros" in a field a
Thai banking app reads as baht, so a transfer in any other currency renders **no
code at all**. A figure the payer cannot tell is being misread is worse than a
missing convenience.

**The name check is untouched.** The payload carries no account holder name, so a
QR proves nothing about who owns the account. PLAN §17.2's comparison instruction
and the holder name stay on screen beside the code, outside every fold.

**The bank-issued e-wallet identifier stays unimportable.** Reaching it means
decoding a QR the user's own banking app produced. It buys nothing for someone who
has registered a mobile or ID-card proxy, and asking people to point this app at
their banking QR is a gesture indistinguishable from phishing.

## A QR is obfuscation, not protection

A receiving profile is visible to every co-member of every shared group (PLAN
§17.3), and a national ID printed in a list is far more sensitive than a phone
number — it is exactly the proxy someone chooses _because_ they will not publish a
phone number. Leading with the code and keeping the raw proxy behind a reveal is
therefore worth doing, and it is a reason to build the feature rather than only a
convenience.

But the proxy is inside the code in plain digits: anyone who screenshots it and
decodes it has the number. **No copy anywhere may imply the code hides anything.**
The reveal says "show", and nothing claims privacy, protection or secrecy.

## Unchanged from ADR-0016

Receiving methods still write **no `audit_log` row** — a QR is a read, and this
feature still never touches the ledger.
